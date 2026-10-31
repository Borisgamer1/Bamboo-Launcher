/**
 * Version JSON fixtures for the phase 3 resolver tests.
 *
 * They are intentionally small but keep every shape that matters:
 * legacy `minecraftArguments`, native classifiers, rules, modern `arguments`,
 * Forge/Fabric deltas, a legacy virtual asset index and an inheritance cycle.
 */

const hash = (seed, length = 40) => (seed.repeat(length).slice(0, length))

const versions = {
  '1.8.9': {
    id: '1.8.9',
    type: 'release',
    time: '2015-12-03T09:24:41+00:00',
    releaseTime: '2015-12-03T09:24:41+00:00',
    minimumLauncherVersion: 14,
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments:
      '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType legacy --versionType ${version_type}',
    assets: '1.8',
    assetIndex: {
      id: '1.8',
      sha1: hash('a'),
      size: 78494,
      totalSize: 1200000,
      url: 'https://example.invalid/1.8.json',
    },
    downloads: { client: { sha1: hash('c'), size: 1000, url: 'https://example.invalid/client-1.8.9.jar' } },
    libraries: [
      {
        name: 'com.mojang:netty:1.6.1',
        downloads: {
          artifact: {
            path: 'com/mojang/netty/1.6.1/netty-1.6.1.jar',
            sha1: hash('b'),
            size: 10,
            url: 'https://example.invalid/netty-1.6.1.jar',
          },
        },
        rules: [{ action: 'allow' }],
      },
      {
        name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209',
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar',
            sha1: hash('d'),
            size: 20,
          },
        },
        rules: [{ action: 'allow' }],
      },
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
        natives: { linux: 'natives-linux', windows: 'natives-windows', osx: 'natives-osx' },
        extract: { exclude: ['META-INF/'] },
        downloads: {
          classifiers: {
            'natives-windows': {
              path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar',
              sha1: hash('e'),
              size: 30,
            },
            'natives-osx': {
              path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-osx.jar',
              sha1: hash('f'),
              size: 31,
            },
          },
        },
        rules: [{ action: 'allow' }],
      },
      {
        name: 'example:windows-only:1.0',
        downloads: {
          artifact: { path: 'example/windows-only/1.0/windows-only-1.0.jar', sha1: hash('1'), size: 1 },
        },
        rules: [{ action: 'allow', os: { name: 'windows' } }],
      },
      {
        name: 'example:osx-only:1.0',
        downloads: {
          artifact: { path: 'example/osx-only/1.0/osx-only-1.0.jar', sha1: hash('2'), size: 1 },
        },
        rules: [{ action: 'allow', os: { name: 'osx' } }],
      },
    ],
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
  },

  '1.20.1': {
    id: '1.20.1',
    type: 'release',
    time: '2023-06-12T12:22:16+00:00',
    releaseTime: '2023-06-12T12:22:16+00:00',
    minimumLauncherVersion: 21,
    mainClass: 'net.minecraft.client.main.Main',
    arguments: {
      game: [
        '--username',
        '${auth_player_name}',
        '--version',
        '${version_name}',
        {
          rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}'],
        },
        { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
      ],
      jvm: [
        {
          rules: [{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }],
          value: ['-Dos.name=Windows 10', '-Dos.version=10.0'],
        },
        '-Djava.library.path=${natives_directory}',
        '-cp',
        '${classpath}',
      ],
    },
    assets: '5',
    assetIndex: {
      id: '5',
      sha1: hash('9'),
      size: 413067,
      totalSize: 600000,
      url: 'https://example.invalid/5.json',
    },
    downloads: { client: { sha1: hash('8'), size: 2000, url: 'https://example.invalid/client-1.20.1.jar' } },
    libraries: [
      {
        name: 'com.mojang:brigadier:1.0.18',
        downloads: {
          artifact: { path: 'com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar', sha1: hash('3'), size: 1 },
        },
      },
      {
        name: 'org.ow2.asm:asm:9.3',
        downloads: { artifact: { path: 'org/ow2/asm/asm/9.3/asm-9.3.jar', sha1: hash('4'), size: 1 } },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1',
        downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar', sha1: hash('5'), size: 1 } },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-windows',
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
            sha1: hash('6'),
            size: 1,
          },
        },
        rules: [{ action: 'allow', os: { name: 'windows' } }],
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-macos',
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-macos.jar',
            sha1: hash('7'),
            size: 1,
          },
        },
        rules: [{ action: 'allow', os: { name: 'osx' } }],
      },
    ],
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  },

  '1.20.1-forge-47.2.0': {
    id: '1.20.1-forge-47.2.0',
    inheritsFrom: '1.20.1',
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: {
      game: [],
      jvm: ['-Dforge.logging.console.level=info', '-DlibraryDirectory=${library_directory}'],
    },
    libraries: [
      {
        name: 'org.ow2.asm:asm:9.5',
        downloads: { artifact: { path: 'org/ow2/asm/asm/9.5/asm-9.5.jar', sha1: hash('a'), size: 1 } },
      },
      {
        name: 'net.minecraftforge:forge:1.20.1-47.2.0:universal',
        downloads: {
          artifact: {
            path: 'net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar',
            sha1: hash('b'),
            size: 1,
          },
        },
      },
    ],
  },

  'fabric-loader-0.15.0-1.20.1': {
    id: 'fabric-loader-0.15.0-1.20.1',
    inheritsFrom: '1.20.1',
    type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { game: [], jvm: ['-DFabricMcEmu=net.minecraft.client.main.Main'] },
    libraries: [
      {
        name: 'net.fabricmc:fabric-loader:0.15.0',
        downloads: {
          artifact: {
            path: 'net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar',
            sha1: hash('c'),
            size: 1,
          },
        },
      },
      {
        name: 'org.ow2.asm:asm:9.6',
        downloads: { artifact: { path: 'org/ow2/asm/asm/9.6/asm-9.6.jar', sha1: hash('d'), size: 1 } },
      },
    ],
  },

  '1.6.4': {
    id: '1.6.4',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --gameDir ${game_directory} --assetsDir ${assets_root}',
    assets: 'legacy',
    libraries: [],
  },

  'cycle-a': {
    id: 'cycle-a',
    inheritsFrom: 'cycle-b',
    mainClass: 'example.Cycle',
    libraries: [],
  },
  'cycle-b': {
    id: 'cycle-b',
    inheritsFrom: 'cycle-a',
    mainClass: 'example.Cycle',
    libraries: [],
  },
}

const assets = {
  '1.8.json': {
    objects: {
      'minecraft/sounds/random/click.ogg': { hash: hash('1'), size: 1234 },
      'minecraft/lang/en_US.lang': { hash: hash('2'), size: 5678 },
      'minecraft/textures/gui/widgets.png': { hash: hash('3'), size: 91011 },
    },
  },
  '5.json': {
    objects: {
      'minecraft/sounds/random/click.ogg': { hash: hash('4'), size: 100 },
      'minecraft/lang/en_us.json': { hash: hash('5'), size: 200 },
      'minecraft/textures/gui/widgets.png': { hash: hash('6'), size: 300 },
      'minecraft/models/block/stone.json': { hash: hash('7'), size: 400 },
    },
  },
  'legacy.json': {
    virtual: true,
    objects: {
      'sound/click.ogg': { hash: hash('8'), size: 10 },
      'lang/en_US.lang': { hash: hash('9'), size: 20 },
    },
  },
}

module.exports = { versions, assets, hash }
