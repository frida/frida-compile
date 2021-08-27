const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: './index.ts',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      buffer: require.resolve('buffer/'),
      fs: require.resolve('frida-fs'),
      path: require.resolve('path-browserify'),
      stream: require.resolve('stream-browserify'),
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
    })
  ],
  output: {
    filename: 'agent.js',
    path: path.resolve(__dirname, 'dist'),
  },
};
