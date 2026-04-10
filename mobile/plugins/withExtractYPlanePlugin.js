/**
 * Expo config plugin that adds the ExtractYPlane native Frame Processor Plugin.
 *
 * This plugin:
 * 1. Copies ExtractYPlanePlugin.kt into the Android app source tree
 * 2. Registers it in MainApplication.kt via FrameProcessorPluginRegistry
 *
 * The native plugin extracts the Y (grayscale) plane from YUV_420_888 camera
 * frames, bypassing VisionCamera's toArrayBuffer() which is broken for YUV
 * on Android (Image.getHardwareBuffer() returns null for YUV formats).
 */
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PLUGIN_KOTLIN = `package com.gearcounter.app

import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.SharedArray
import com.mrousavy.camera.frameprocessors.VisionCameraProxy

/**
 * VisionCamera Frame Processor Plugin that extracts the Y (luminance) plane
 * from YUV_420_888 frames and returns it as a SharedArray (ArrayBuffer in JS).
 *
 * This bypasses frame.toArrayBuffer() which is broken for YUV frames on Android
 * because Image.getHardwareBuffer() returns null for YUV_420_888 format.
 *
 * The Y plane IS the grayscale image — one byte per pixel, full resolution.
 */
class ExtractYPlanePlugin(
    private val proxy: VisionCameraProxy,
    options: Map<String, Any>?
) : FrameProcessorPlugin() {

    private var cachedArray: SharedArray? = null
    private var cachedSize: Int = 0

    override fun callback(frame: Frame, params: Map<String, Any>?): Any? {
        val image = frame.image
        val width = image.width
        val height = image.height
        val size = width * height

        val yPlane = image.planes[0]
        val yBuffer = yPlane.buffer
        val rowStride = yPlane.rowStride

        // Reuse SharedArray if size matches to avoid allocation churn
        if (cachedArray == null || cachedSize != size) {
            cachedArray = SharedArray(proxy, size)
            cachedSize = size
        }
        val dst = cachedArray!!.byteBuffer
        dst.rewind()

        yBuffer.position(0)
        if (rowStride == width) {
            // No row padding — bulk copy
            yBuffer.limit(size)
            dst.put(yBuffer)
        } else {
            // Row padding present — copy row by row, skipping padding bytes
            for (row in 0 until height) {
                yBuffer.position(row * rowStride)
                yBuffer.limit(row * rowStride + width)
                dst.put(yBuffer)
            }
        }

        return cachedArray
    }
}
`;

function withExtractYPlanePlugin(config) {
  // Step 1: Write the Kotlin source file into android/app/src/main/java/...
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const pkg = config.android?.package || 'com.gearcounter.app';
      const pkgPath = pkg.replace(/\./g, '/');
      const srcDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', pkgPath,
      );
      fs.mkdirSync(srcDir, { recursive: true });

      const pluginPath = path.join(srcDir, 'ExtractYPlanePlugin.kt');
      // Update package name in the Kotlin source
      const kotlinSource = PLUGIN_KOTLIN.replace(
        'package com.gearcounter.app',
        `package ${pkg}`,
      );
      fs.writeFileSync(pluginPath, kotlinSource);
      return config;
    },
  ]);

  // Step 2: Register the plugin in MainApplication.kt
  config = withMainApplication(config, (config) => {
    let contents = config.modResults.contents;

    // Add import if not present
    const importLine = 'import com.mrousavy.camera.frameprocessors.FrameProcessorPluginRegistry';
    if (!contents.includes(importLine)) {
      // Insert after the last import line
      const lastImportIdx = contents.lastIndexOf('\nimport ');
      const nextLineIdx = contents.indexOf('\n', lastImportIdx + 1);
      contents =
        contents.slice(0, nextLineIdx + 1) +
        importLine + '\n' +
        contents.slice(nextLineIdx + 1);
    }

    // Add companion object with static initializer if not present
    const registrationCode = `FrameProcessorPluginRegistry.addFrameProcessorPlugin("extractYPlane")`;
    if (!contents.includes(registrationCode)) {
      // Insert the companion object after the class opening
      const classPattern = /class\s+MainApplication\s*:\s*Application\(\)\s*,\s*ReactApplication\s*\{/;
      contents = contents.replace(classPattern, (match) =>
        match + `\n\n  companion object {\n    init {\n      ${registrationCode} { proxy, options ->\n        ExtractYPlanePlugin(proxy, options)\n      }\n    }\n  }\n`,
      );
    }

    config.modResults.contents = contents;
    return config;
  });

  return config;
}

module.exports = withExtractYPlanePlugin;
