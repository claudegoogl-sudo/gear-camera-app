// PAP-1694 option A — JNI entry point that installs the JSI bindings.
//
// The package in the symbol name below is rewritten by
// plugins/withGearKernelsPlugin.js if the app's Android package ever changes;
// JNI symbol names are derived from the fully-qualified Java class name and
// there is no way to make that dynamic.
#include <jni.h>

#include <jsi/jsi.h>

#include "GearKernelsJsi.h"

extern "C" JNIEXPORT void JNICALL
Java_com_gearcounter_app_GearKernelsModule_nativeInstall(JNIEnv*, jobject,
                                                         jlong jsiRuntimeRef) {
  if (jsiRuntimeRef == 0) return;
  auto* runtime = reinterpret_cast<facebook::jsi::Runtime*>(jsiRuntimeRef);
  gearkernels::installGearKernels(*runtime);
}
