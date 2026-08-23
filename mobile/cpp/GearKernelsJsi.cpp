#include "GearKernelsJsi.h"

#include <jsi/jsi.h>

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

}  // namespace

void installGearKernels(jsi::Runtime& rt) {
  jsi::Object api(rt);
  api.setProperty(rt, "version", jsi::Value(kSemanticsVersion));
  api.setProperty(
      rt, "preprocess",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "preprocess"), 4, preprocessHost));
  rt.global().setProperty(rt, "__gearKernels", api);
}

}  // namespace gearkernels
