// PAP-1694 option A — JSI surface for the native preprocess kernels.
#pragma once

namespace facebook {
namespace jsi {
class Runtime;
}
}  // namespace facebook

namespace gearkernels {

// Installs `globalThis.__gearKernels` on `rt`.  Idempotent: installing twice
// simply overwrites the global with an equivalent object.
//
//   __gearKernels.version           -> number (kSemanticsVersion)
//   __gearKernels.preprocess(buffer, byteOffset, width, height)
//       buffer     : ArrayBuffer holding RGBA bytes
//       byteOffset : offset of the RGBA view inside `buffer`
//       returns    : { gray, enhanced, blurred, edges } — four ArrayBuffers of
//                    width*height bytes, in the same order the JS backend
//                    produces them.
//
// Synchronous and on the JS thread by design: the call sites in gearCounter.js
// are already synchronous, and the point of the port is that the work is now
// fast enough not to need a worklet hop.
void installGearKernels(facebook::jsi::Runtime& rt);

}  // namespace gearkernels
