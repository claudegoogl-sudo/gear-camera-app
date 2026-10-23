#include "GearKernelsJsi.h"

#include <jsi/jsi.h>

#include <cstring>
#include <memory>
#include <utility>
#include <vector>

#include "gear_kernels.h"

using namespace facebook;

namespace gearkernels {
namespace {

// Owns the output plane and hands its bytes to JS as an ArrayBuffer with no
// copy.  The buffer stays alive as long as JS holds the ArrayBuffer.
class VectorBuffer : public jsi::MutableBuffer {
 public:
  explicit VectorBuffer(size_t size) : data_(size) {}
  size_t size() const override { return data_.size(); }
  uint8_t* data() override { return data_.data(); }

 private:
  std::vector<uint8_t> data_;
};

// jsi::Runtime::createArrayBuffer is protected; jsi::ArrayBuffer's public
// (Runtime&, shared_ptr<MutableBuffer>) constructor is the sanctioned way in.
jsi::Value makePlane(jsi::Runtime& rt, std::shared_ptr<VectorBuffer> buf) {
  return jsi::Value(rt, jsi::ArrayBuffer(rt, std::move(buf)));
}

jsi::Value preprocessHost(jsi::Runtime& rt, const jsi::Value&,
                          const jsi::Value* args, size_t count) {
  if (count < 4) {
    throw jsi::JSError(rt, "__gearKernels.preprocess(buffer, byteOffset, width, height)");
  }
  if (!args[0].isObject() || !args[0].getObject(rt).isArrayBuffer(rt)) {
    throw jsi::JSError(rt, "__gearKernels.preprocess: arg 0 must be an ArrayBuffer");
  }

  jsi::ArrayBuffer in = args[0].getObject(rt).getArrayBuffer(rt);
  const size_t byteOffset = static_cast<size_t>(args[1].asNumber());
  const int width = static_cast<int>(args[2].asNumber());
  const int height = static_cast<int>(args[3].asNumber());
  if (width <= 0 || height <= 0) {
    throw jsi::JSError(rt, "__gearKernels.preprocess: width/height must be positive");
  }

  const size_t len = static_cast<size_t>(width) * static_cast<size_t>(height);
  if (byteOffset + len * 4 > in.size(rt)) {
    throw jsi::JSError(rt, "__gearKernels.preprocess: buffer is too small for width*height*4");
  }
  const uint8_t* rgba = in.data(rt) + byteOffset;

  auto gray = std::make_shared<VectorBuffer>(len);
  auto enhanced = std::make_shared<VectorBuffer>(len);
  auto blurred = std::make_shared<VectorBuffer>(len);
  auto edges = std::make_shared<VectorBuffer>(len);

  preprocess(rgba, width, height, gray->data(), enhanced->data(), blurred->data(),
             edges->data());

  jsi::Object out(rt);
  out.setProperty(rt, "gray", makePlane(rt, std::move(gray)));
  out.setProperty(rt, "enhanced", makePlane(rt, std::move(enhanced)));
  out.setProperty(rt, "blurred", makePlane(rt, std::move(blurred)));
  out.setProperty(rt, "edges", makePlane(rt, std::move(edges)));
  return jsi::Value(rt, out);
}

// PAP-2022: morphClose/morphOpen(buffer, byteOffset, w, h, radius) -> ArrayBuffer
jsi::Value morphHost(jsi::Runtime& rt, const jsi::Value* args, size_t count, bool close) {
  if (count < 5 || !args[0].isObject() || !args[0].getObject(rt).isArrayBuffer(rt)) {
    throw jsi::JSError(rt, "morph(buffer, byteOffset, width, height, radius)");
  }
  jsi::ArrayBuffer in = args[0].getObject(rt).getArrayBuffer(rt);
  const size_t off = static_cast<size_t>(args[1].asNumber());
  const int w = static_cast<int>(args[2].asNumber());
  const int h = static_cast<int>(args[3].asNumber());
  const int r = static_cast<int>(args[4].asNumber());
  if (w <= 0 || h <= 0 || r < 0 || off + static_cast<size_t>(w) * h > in.size(rt)) {
    throw jsi::JSError(rt, "morph: bad dimensions");
  }
  auto out = std::make_shared<VectorBuffer>(static_cast<size_t>(w) * h);
  if (close) morphClose(in.data(rt) + off, w, h, r, out->data());
  else morphOpen(in.data(rt) + off, w, h, r, out->data());
  return makePlane(rt, std::move(out));
}

// labelComponents(buffer, byteOffset, w, h, targetVal) -> {labels, comps(Float64 buffer, 9/comp)}
jsi::Value labelHost(jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
  if (count < 5 || !args[0].isObject() || !args[0].getObject(rt).isArrayBuffer(rt)) {
    throw jsi::JSError(rt, "labelComponents(buffer, byteOffset, width, height, targetVal)");
  }
  jsi::ArrayBuffer in = args[0].getObject(rt).getArrayBuffer(rt);
  const size_t off = static_cast<size_t>(args[1].asNumber());
  const int w = static_cast<int>(args[2].asNumber());
  const int h = static_cast<int>(args[3].asNumber());
  const int tv = static_cast<int>(args[4].asNumber());
  if (w <= 0 || h <= 0 || off + static_cast<size_t>(w) * h > in.size(rt)) {
    throw jsi::JSError(rt, "labelComponents: bad dimensions");
  }
  auto labels = std::make_shared<VectorBuffer>(static_cast<size_t>(w) * h * 4);
  std::vector<double> comps;
  labelComponents(in.data(rt) + off, w, h, tv, reinterpret_cast<int32_t*>(labels->data()), comps);
  auto cb = std::make_shared<VectorBuffer>(comps.size() * sizeof(double));
  if (!comps.empty()) std::memcpy(cb->data(), comps.data(), comps.size() * sizeof(double));
  jsi::Object o(rt);
  o.setProperty(rt, "labels", makePlane(rt, std::move(labels)));
  o.setProperty(rt, "comps", makePlane(rt, std::move(cb)));
  return jsi::Value(rt, o);
}

}  // namespace

void installGearKernels(jsi::Runtime& rt) {
  jsi::Object api(rt);
  api.setProperty(rt, "version", jsi::Value(kSemanticsVersion));
  api.setProperty(
      rt, "preprocess",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "preprocess"), 4, preprocessHost));
  api.setProperty(rt, "morphClose", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "morphClose"), 5,
      [](jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t c) { return morphHost(r, a, c, true); }));
  api.setProperty(rt, "morphOpen", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "morphOpen"), 5,
      [](jsi::Runtime& r, const jsi::Value&, const jsi::Value* a, size_t c) { return morphHost(r, a, c, false); }));
  api.setProperty(rt, "labelComponents", jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, "labelComponents"), 5, labelHost));
  rt.global().setProperty(rt, "__gearKernels", api);
}

}  // namespace gearkernels
