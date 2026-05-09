const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Register binary asset types Metro doesn't know about by default.
// IMPORTANT: ort.min.js must be renamed to ort-runtime.bin (or any non-.js ext)
// because Metro tries to transform .js files and chokes on ORT's dynamic import().
config.resolver.assetExts.push('onnx', 'wasm', 'bin');

module.exports = config;