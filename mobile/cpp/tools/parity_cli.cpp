// PAP-1694 option A — host parity CLI.
//
// Runs the native preprocess kernels over a raw RGBA plane and writes the four
// stage outputs, so mobile/__tests__/pap1694.native-parity.mjs can diff them
// byte-for-byte against the JS implementation on the cached corpus.
//
// This is a host-only tool (g++, x86-64).  It shares the exact same
// translation unit as the Android build, so a byte-parity pass here is
// evidence about the kernels' semantics, not about the NDK toolchain — see
// the caveat in docs/pap1694-native-kernels.md.
//
//   parity_cli <in.rgba> <width> <height> <out-prefix>
// writes <out-prefix>.{gray,clahe,blur,canny}.bin
//
// With --bench <reps> it instead times each kernel and prints one JSON object.

#include "../gear_kernels.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::vector<uint8_t> readFile(const char* path) {
  FILE* f = std::fopen(path, "rb");
  if (!f) { std::fprintf(stderr, "cannot open %s\n", path); std::exit(2); }
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> buf(static_cast<size_t>(n));
  if (std::fread(buf.data(), 1, buf.size(), f) != buf.size()) {
    std::fprintf(stderr, "short read on %s\n", path); std::exit(2);
  }
  std::fclose(f);
  return buf;
}

void writeFile(const std::string& path, const std::vector<uint8_t>& buf) {
  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) { std::fprintf(stderr, "cannot write %s\n", path.c_str()); std::exit(2); }
  std::fwrite(buf.data(), 1, buf.size(), f);
  std::fclose(f);
}

double msSince(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now() - t0).count();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 5) {
    std::fprintf(stderr,
        "usage: parity_cli <in.rgba> <width> <height> <out-prefix> [--bench N]\n");
    return 1;
  }
  const std::vector<uint8_t> rgba = readFile(argv[1]);
  const int w = std::atoi(argv[2]);
  const int h = std::atoi(argv[3]);
  const std::string prefix = argv[4];
  const size_t len = static_cast<size_t>(w) * static_cast<size_t>(h);
  if (rgba.size() != len * 4) {
    std::fprintf(stderr, "size mismatch: %zu bytes for %dx%d\n", rgba.size(), w, h);
    return 2;
  }

  int reps = 0;
  if (argc >= 7 && std::strcmp(argv[5], "--bench") == 0) reps = std::atoi(argv[6]);

  std::vector<uint8_t> gray(len), enhanced(len), blurred(len), edges(len);

  if (reps > 0) {
    double tGray = 0, tClahe = 0, tBlur = 0, tCanny = 0;
    for (int r = 0; r < reps; r++) {
      auto t = std::chrono::steady_clock::now();
      gearkernels::rgbaToGray(rgba.data(), w, h, gray.data());
      tGray += msSince(t);
      t = std::chrono::steady_clock::now();
      gearkernels::clahe(gray.data(), w, h, 3.0, 8, 8, enhanced.data());
      tClahe += msSince(t);
      t = std::chrono::steady_clock::now();
      gearkernels::gaussianBlur5x5(enhanced.data(), w, h, blurred.data());
      tBlur += msSince(t);
      t = std::chrono::steady_clock::now();
      gearkernels::cannyEdges(blurred.data(), w, h, 50, 150, edges.data());
      tCanny += msSince(t);
    }
    std::printf(
        "{\"reps\":%d,\"tGray\":%.4f,\"tClahe\":%.4f,\"tBlur\":%.4f,"
        "\"tCanny\":%.4f,\"total\":%.4f}\n",
        reps, tGray / reps, tClahe / reps, tBlur / reps, tCanny / reps,
        (tGray + tClahe + tBlur + tCanny) / reps);
  } else {
    gearkernels::preprocess(rgba.data(), w, h, gray.data(), enhanced.data(),
                            blurred.data(), edges.data());
  }

  writeFile(prefix + ".gray.bin", gray);
  writeFile(prefix + ".clahe.bin", enhanced);
  writeFile(prefix + ".blur.bin", blurred);
  writeFile(prefix + ".canny.bin", edges);
  return 0;
}
