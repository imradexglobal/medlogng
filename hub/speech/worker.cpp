// Persistent single-model worker for the MediLog Host. Input is one line per
// job: <safe-job-id> TAB <absolute 16 kHz mono PCM16 WAV path>. Output is
// <job-id> TAB OK|ERR TAB <base64 UTF-8 text>. No network socket is opened.
#include "whisper.h"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace fs = std::filesystem;

static uint16_t u16(const std::vector<uint8_t>& b, size_t p) {
    return static_cast<uint16_t>(b[p] | (static_cast<uint16_t>(b[p + 1]) << 8));
}
static uint32_t u32(const std::vector<uint8_t>& b, size_t p) {
    return static_cast<uint32_t>(b[p]) | (static_cast<uint32_t>(b[p + 1]) << 8) |
           (static_cast<uint32_t>(b[p + 2]) << 16) | (static_cast<uint32_t>(b[p + 3]) << 24);
}
static bool fourcc(const std::vector<uint8_t>& b, size_t p, const char* s) {
    return p + 4 <= b.size() && b[p] == s[0] && b[p + 1] == s[1] && b[p + 2] == s[2] && b[p + 3] == s[3];
}

static std::vector<float> readWav(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("Could not open audio file.");
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (bytes.size() < 44 || bytes.size() > 32u * 1024u * 1024u || !fourcc(bytes, 0, "RIFF") || !fourcc(bytes, 8, "WAVE"))
        throw std::runtime_error("Audio must be a valid PCM WAV file under 32 MB.");

    uint16_t format = 0, channels = 0, bits = 0;
    uint32_t rate = 0;
    size_t dataAt = 0, dataSize = 0;
    for (size_t p = 12; p + 8 <= bytes.size();) {
        const uint32_t n = u32(bytes, p + 4);
        const size_t start = p + 8;
        if (n > bytes.size() - start) throw std::runtime_error("Corrupt WAV chunk.");
        if (fourcc(bytes, p, "fmt ") && n >= 16) {
            format = u16(bytes, start);
            channels = u16(bytes, start + 2);
            rate = u32(bytes, start + 4);
            bits = u16(bytes, start + 14);
        } else if (fourcc(bytes, p, "data")) {
            dataAt = start;
            dataSize = n;
        }
        p = start + n + (n & 1u);
    }
    if (format != 1 || channels != 1 || rate != 16000 || bits != 16 || !dataSize || (dataSize & 1u))
        throw std::runtime_error("Expected 16 kHz mono 16-bit PCM WAV audio.");
    if (dataSize / 2 > 16'000u * 5u * 60u) throw std::runtime_error("Recording exceeds five minutes.");

    std::vector<float> pcm;
    pcm.reserve(dataSize / 2);
    for (size_t p = dataAt; p < dataAt + dataSize; p += 2) {
        const int16_t sample = static_cast<int16_t>(u16(bytes, p));
        pcm.push_back(static_cast<float>(sample) / 32768.0f);
    }
    return pcm;
}

static std::string base64(const std::string& input) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((input.size() + 2) / 3) * 4);
    for (size_t i = 0; i < input.size(); i += 3) {
        const uint32_t a = static_cast<unsigned char>(input[i]);
        const uint32_t b = i + 1 < input.size() ? static_cast<unsigned char>(input[i + 1]) : 0;
        const uint32_t c = i + 2 < input.size() ? static_cast<unsigned char>(input[i + 2]) : 0;
        const uint32_t n = (a << 16) | (b << 8) | c;
        out.push_back(alphabet[(n >> 18) & 63]); out.push_back(alphabet[(n >> 12) & 63]);
        out.push_back(i + 1 < input.size() ? alphabet[(n >> 6) & 63] : '=');
        out.push_back(i + 2 < input.size() ? alphabet[n & 63] : '=');
    }
    return out;
}

static bool safeId(const std::string& id) {
    return !id.empty() && id.size() <= 80 && std::all_of(id.begin(), id.end(), [](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    });
}

static void respond(const std::string& id, const char* kind, const std::string& text) {
    std::cout << id << '\t' << kind << '\t' << base64(text) << '\n' << std::flush;
}

static std::string utf8(const fs::path& p) {
    const auto u = p.u8string();
    return std::string(reinterpret_cast<const char*>(u.data()), u.size());
}

int wmain(int argc, wchar_t** argv) {
#ifdef _WIN32
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
#endif
    fs::path model, audioRoot;
    int threads = 1;
    for (int i = 1; i + 1 < argc; ++i) {
        const std::wstring arg(argv[i]);
        if (arg == L"--model") model = argv[++i];
        else if (arg == L"--audio-dir") audioRoot = argv[++i];
        else if (arg == L"--threads") threads = std::stoi(argv[++i]);
    }
    threads = std::clamp(threads, 1, 2);
    if (model.empty() || audioRoot.empty()) {
        std::cerr << "Required arguments: --model and --audio-dir\n";
        return 2;
    }

    whisper_context_params contextParams = whisper_context_default_params();
    contextParams.use_gpu = false;
    whisper_context* ctx = whisper_init_from_file_with_params(utf8(model).c_str(), contextParams);
    if (!ctx) {
        std::cerr << "Could not load Whisper model.\n";
        return 3;
    }
    std::cout << "READY\n" << std::flush;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line == "QUIT") break;
        const size_t tab = line.find('\t');
        const std::string id = tab == std::string::npos ? "" : line.substr(0, tab);
        if (!safeId(id) || tab == std::string::npos || tab + 1 >= line.size()) {
            respond(safeId(id) ? id : "invalid", "ERR", "Malformed worker request.");
            continue;
        }
        try {
            const fs::path root = fs::weakly_canonical(audioRoot);
            const fs::path audio = fs::weakly_canonical(fs::u8path(line.substr(tab + 1)));
            const auto rel = audio.lexically_relative(root);
            if (rel.empty() || rel.is_absolute() || *rel.begin() == L"..")
                throw std::runtime_error("Audio path is outside the temporary folder.");
            auto pcm = readWav(audio);
            auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
            params.n_threads = threads;
            params.language = "en";
            params.translate = false;
            params.no_context = true;
            params.print_progress = false;
            params.print_realtime = false;
            params.print_timestamps = false;
            params.no_timestamps = true;
            if (whisper_full(ctx, params, pcm.data(), static_cast<int>(pcm.size())) != 0)
                throw std::runtime_error("Whisper could not transcribe this recording.");
            std::string text;
            for (int i = 0; i < whisper_full_n_segments(ctx); ++i) text += whisper_full_get_segment_text(ctx, i);
            respond(id, "OK", text);
        } catch (const std::exception& e) {
            respond(id, "ERR", e.what());
        } catch (...) {
            respond(id, "ERR", "Unexpected speech engine failure.");
        }
    }
    whisper_free(ctx);
    return 0;
}
