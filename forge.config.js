const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const package = require('./package.json');

module.exports = {
  packagerConfig: {
    asar: {
      unpack: "**/{node_modules/@ffmpeg-installer/**,node_modules/ffmpeg-installer/**}"
    },
    appBundleId: "app.anixartix.desktop",
    name: "AnixArtix",
    appCopyright: "AnixArtix",
    icon: "icon/icon",
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'AnixArtix',
        authors: 'AnixArtix',
        iconUrl: "https://raw.githubusercontent.com/pyanexya/AniTogether/main/icon/Logo.png",
        setupExe: `AnixArtix-${package.version}-win32.exe`,
        setupIcon: 'icon/icon.ico',
        // No upstream-branded installer animation.
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: "anixartix",
          productName: "AnixArtix",
          icon: "icon/icon.ico",
          maintainer: 'MjKey',
          homepage: "https://github.com/pyanexya/AniTogether",
        }
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
