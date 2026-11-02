# Local model fit review

**Review date:** 2026-11-02. No model was downloaded or run. The development machine is not the target Host.

## Machine evidence

- OS: Windows 10.0.26300.
- CPU: Intel Core i5-8365U @ 1.60 GHz, 4 cores / 8 logical processors.
- Physical RAM: 8.39 GB. Free RAM at inspection: 1.19 GB, later 0.63 GB while installing/test-running Functions dependencies.
- C: drive free space: 116.4 GB.
- GPU: Intel UHD Graphics 620 integrated graphics; Windows reports 1 GiB AdapterRAM. This is shared-memory integrated graphics, not a dedicated inference GPU; no supported acceleration path was verified.
- Ollama: not installed; no model files were found in the standard locations.

The 8 GB development machine does not represent a 4 GB Host. With less than 1 GB free during this session, downloading/loading a model or running the emulator suite risked destabilizing active desktop work. C: had approximately 116.4 GB free. No local model performance or quality result is claimed.

## Candidate comparison

Ollama library download sizes are weight-file sizes, not full working-memory requirements. Actual RAM depends on runtime buffers, context/KV cache, generation length, and whether Whisper, Electron and Windows services are resident. CPU-generation throughput must be measured on the hospital Host.

| Candidate | Listed quantized size / context | Structured JSON | Medical documentation and Nigerian English assessment | 4 GB Host view |
|---|---|---|---|---|
| Qwen3 0.6B Q4_K_M | 523 MB / 40K | Ollama can constrain output with JSON Schema | General model; no Nigerian-English SOAP accuracy evidence found. Smallest candidate, but no clinical adequacy established. | Most plausible resource experiment, not a safe recommendation without review |
| Gemma 3 1B Q4_K_M | 806 MB / 32K | Ollama JSON Schema output | General multilingual model; Google describes 140+ languages but does not establish Nigerian-English clinical note quality. | Plausible resource experiment; low parameter count is not evidence of clinical accuracy |
| Llama 3.2 1B | 1.3 GB / 128K | Ollama JSON Schema output | General summarization model. Meta’s documented supported-language list names English but not Nigerian English, Yoruba or Hausa. | Likely tight with Whisper/runtime on 4 GB |
| MedGemma 1.5 4B Q4 | 3.3 GB / 128K | Ollama JSON Schema output | Medical text/image comprehension model; this does not establish safe transcript-to-SOAP performance or Nigerian-English accuracy. | Not viable for a 4 GB Host alongside Windows and Whisper |

Ollama documents JSON Schema constrained output; the Host adapter now sends a closed schema, and still independently validates exact evidence spans. Schema validity does not prevent a semantically unsupported sentence from citing a real but irrelevant quote. The UI flags that limitation and requires clinician review. References: [Qwen3 tags](https://ollama.com/library/qwen3/tags), [Gemma 3 tags](https://ollama.com/library/gemma3/tags), [Llama 3.2](https://ollama.com/library/llama3.2), [MedGemma 1.5 tags](https://ollama.com/library/medgemma1.5/tags), [Ollama structured outputs](https://ollama.com/blog/structured-outputs), [Gemma 3 model card](https://ai.google.dev/gemma/docs/core/model_card_3).

No cited model provides a verified MediLogNG evaluation for Nigerian English, Nigerian medical terms, or medium-length Nigerian consultations. A small local model must not be described as suitable until its output is judged against a clinician-authored synthetic suite and a separately approved de-identified clinical corpus.

## Resource protection implemented

- The Host serializes Ollama documentation generation and Whisper inference through a shared single inference lane.
- The local AI queue accepts one active request and up to two waiting requests; excess generation requests fail with a clear busy response.
- Ollama is asked to unload the model after each generation (`keep_alive: 0`) so subsequent Whisper activity does not compete with a resident AI model.
- Automated queue tests use deterministic mock workers and confirm AI/Whisper calls do not overlap. This is a scheduling test, not a RAM, CPU, latency or real-model measurement.

## Recommendation

Do not enable local AI on 4 GB Hosts until actual 4 GB hardware testing proves the selected model leaves sufficient headroom for Windows, Whisper, Firebase/Hub and 6–10 ward clients. Start evaluation on a dedicated Host with substantially more RAM or leave AI disabled on low-memory Hosts while retaining local Whisper. If a 4 GB deployment is mandatory, run the clinical AI backend on a separately provisioned, hospital-controlled system after privacy and security approval.
