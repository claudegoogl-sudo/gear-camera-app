// PAP-2022 host parity CLI: morph_cli <mask.bin> <w> <h> <radius> <targetVal> <out-prefix> [reps]
#include "../gear_kernels.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <string>
using namespace gearkernels;
int main(int argc, char** argv) {
  if (argc < 7) return 2;
  int w = atoi(argv[2]), h = atoi(argv[3]), r = atoi(argv[4]), tv = atoi(argv[5]);
  int reps = argc > 7 ? atoi(argv[7]) : 1;
  std::vector<uint8_t> m(size_t(w) * h);
  FILE* f = fopen(argv[1], "rb"); if (!f || fread(m.data(), 1, m.size(), f) != m.size()) return 3; fclose(f);
  std::vector<uint8_t> c(m.size()), o(m.size());
  std::vector<int32_t> lab(m.size()); std::vector<double> comps;
  auto t0 = std::chrono::steady_clock::now();
  for (int i = 0; i < reps; i++) { morphClose(m.data(), w, h, r, c.data()); morphOpen(m.data(), w, h, r, o.data()); labelComponents(m.data(), w, h, tv, lab.data(), comps); }
  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / reps;
  std::string p = argv[6];
  auto wr = [&](const char* s, const void* d, size_t n) { FILE* g = fopen((p + s).c_str(), "wb"); fwrite(d, 1, n, g); fclose(g); };
  wr(".close", c.data(), c.size()); wr(".open", o.data(), o.size());
  wr(".labels", lab.data(), lab.size() * 4); wr(".comps", comps.data(), comps.size() * 8);
  printf("%.3f\n", ms);
}
