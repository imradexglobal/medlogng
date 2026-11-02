cmake_minimum_required(VERSION 3.20)
project(medilog_whisper_worker LANGUAGES C CXX)

if(NOT DEFINED WHISPER_CPP_DIR OR NOT EXISTS "${WHISPER_CPP_DIR}/CMakeLists.txt")
  message(FATAL_ERROR "Set WHISPER_CPP_DIR to the pinned whisper.cpp source tree (v1.9.5).")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build Whisper and ggml as static libraries" FORCE)
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "Disable build-machine-specific CPU instructions" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "Avoid an OpenMP runtime dependency" FORCE)
set(GGML_CUDA OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
set(GGML_BLAS OFF CACHE BOOL "" FORCE)
add_subdirectory("${WHISPER_CPP_DIR}" whisper-cpp EXCLUDE_FROM_ALL)

add_executable(medilog-whisper-worker worker.cpp)
target_link_libraries(medilog-whisper-worker PRIVATE whisper)
set_target_properties(medilog-whisper-worker PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/out"
)
if(WIN32)
  target_compile_definitions(medilog-whisper-worker PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()
