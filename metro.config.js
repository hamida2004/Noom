const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Tell Metro to treat .onnx files as assets (bundle them, don't parse them)
config.resolver.assetExts.push('onnx');

module.exports = config;