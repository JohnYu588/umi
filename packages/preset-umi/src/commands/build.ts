import type { IServicePluginAPI } from '@umijs/core';
import { getMarkup } from '@umijs/server';
import { chalk, fsExtra, logger, rimraf, semver } from '@umijs/utils';
import { writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { IApi, IOnGenerateFiles } from '../types';
import {
  measureFileSizesBeforeBuild,
  printFileSizesAfterBuild,
} from '../utils/fileSizeReporter';
import { lazyImportFromCurrentPkg } from '../utils/lazyImportFromCurrentPkg';
import { getAssetsMap } from './dev/getAssetsMap';
import { getBabelOpts } from './dev/getBabelOpts';
import { getMarkupArgs } from './dev/getMarkupArgs';
import { printMemoryUsage } from './dev/printMemoryUsage';

const bundlerWebpack: typeof import('@umijs/bundler-webpack') =
  lazyImportFromCurrentPkg('@umijs/bundler-webpack');

export default (api: IApi) => {
  api.registerCommand({
    name: 'build',
    description: 'build app for production',
    details: `
umi build

# build without compression
COMPRESS=none umi build

# clean and build
umi build --clean
`,
    fn: async function () {
      logger.info(chalk.cyan.bold(`Umi v${api.appData.umi.version}`));

      // clear tmp
      rimraf.sync(api.paths.absTmpPath);

      // check package.json
      await api.applyPlugins({
        key: 'onCheckPkgJSON',
        args: {
          origin: null,
          current: api.appData.pkg,
        },
      });

      // generate files
      async function generate(opts: IOnGenerateFiles) {
        await api.applyPlugins({
          key: 'onGenerateFiles',
          args: {
            files: opts.files || null,
            isFirstTime: opts.isFirstTime,
          },
        });
      }
      await generate({
        isFirstTime: true,
      });

      // build
      // TODO: support watch mode
      const {
        babelPreset,
        beforeBabelPlugins,
        beforeBabelPresets,
        extraBabelPlugins,
        extraBabelPresets,
      } = await getBabelOpts({ api });
      const chainWebpack = async (memo: any, args: Object) => {
        await api.applyPlugins({
          key: 'chainWebpack',
          type: api.ApplyPluginsType.modify,
          initialValue: memo,
          args,
        });
      };
      const modifyWebpackConfig = async (memo: any, args: Object) => {
        return await api.applyPlugins({
          key: 'modifyWebpackConfig',
          initialValue: memo,
          args,
        });
      };
      const modifyViteConfig = async (memo: any, args: Object) => {
        return await api.applyPlugins({
          key: 'modifyViteConfig',
          initialValue: memo,
          args,
        });
      };
      const entry = await api.applyPlugins({
        key: 'modifyEntry',
        initialValue: {
          umi: join(api.paths.absTmpPath, 'umi.ts'),
        },
      });
      const shouldUseAutomaticRuntime =
        api.appData.react?.version &&
        // why not 16.14.0 ?
        // it will break the config of externals, when externals
        // does not handle the react/runtime
        semver.gte(api.appData.react.version, '17.0.0');
      let opts = {
        react: {
          runtime: shouldUseAutomaticRuntime ? 'automatic' : 'classic',
        },
        config: {
          outputPath: api.userConfig.outputPath || 'dist',
          ...api.config,
        } as IServicePluginAPI['config'],
        cwd: api.cwd,
        entry,
        ...(api.config.vite
          ? { modifyViteConfig }
          : { babelPreset, chainWebpack, modifyWebpackConfig }),
        beforeBabelPlugins,
        beforeBabelPresets,
        extraBabelPlugins,
        extraBabelPresets,
        async onBuildComplete(opts: any) {
          printMemoryUsage();
          await api.applyPlugins({
            key: 'onBuildComplete',
            args: opts,
          });
        },
        clean: true,
        htmlFiles: [] as any[],
      };

      await api.applyPlugins({
        key: 'onBeforeCompiler',
        args: { compiler: api.appData.bundler, opts },
      });

      opts = await api.applyPlugins({
        key: 'modifyUniBundlerOpts',
        initialValue: opts,
        args: {
          bundler: api.appData.bundler,
        },
      });

      const bundler = await api.applyPlugins({
        key: 'modifyUniBundler',
        args: {
          bundler: api.appData.bundler,
          opts,
        },
      });

      const stats = await bundler.build(opts);

      if (!api.config.vite && !api.config.mako) {
        // Measure files sizes before build
        const absOutputPath = resolve(
          opts.cwd,
          opts.config.outputPath || bundlerWebpack.DEFAULT_OUTPUT_PATH,
        );
        const previousFileSizes = measureFileSizesBeforeBuild(absOutputPath);
        // Print files sizes
        console.log();
        logger.info('File sizes after gzip:\n');
        printFileSizesAfterBuild({
          webpackStats: stats,
          previousSizeMap: previousFileSizes,
          buildFolder: absOutputPath,
        });
      }

      // generate html
      // vite 在 build 时通过插件注入 js 和 css

      let htmlFiles: { path: string; content: string }[] = [];

      if (!api.config.mpa) {
        const assetsMap = api.config.vite
          ? {}
          : getAssetsMap({
              stats,
              publicPath: api.config.publicPath,
            });
        const { vite } = api.args;
        const args = await getMarkupArgs({ api });

        const finalMarkUpArgs = {
          ...args,
          styles: args.styles.concat(
            api.config.vite
              ? []
              : [...(assetsMap['umi.css'] || []).map((src) => ({ src }))],
          ),
          scripts: (api.config.vite
            ? []
            : [...(assetsMap['umi.js'] || []).map((src) => ({ src }))]
          ).concat(args.scripts),
          esmScript: !!opts.config.esm || vite,
          path: '/',
        };

        // allow to modify export html files
        htmlFiles = await api.applyPlugins({
          key: 'modifyExportHTMLFiles',
          initialValue: [
            {
              path: 'index.html',
              content: await getMarkup(finalMarkUpArgs),
            },
          ],
          args: { markupArgs: finalMarkUpArgs, getMarkup },
        });

        htmlFiles.forEach(({ path, content }) => {
          const absPath = resolve(api.paths.absOutputPath, path);

          fsExtra.mkdirpSync(dirname(absPath));
          writeFileSync(absPath, content, 'utf-8');
          logger.event(`Build ${path}`);
        });
      }

      // event when html is completed
      await api.applyPlugins({
        key: 'onBuildHtmlComplete',
        args: {
          ...opts,
          htmlFiles,
        },
      });

      // print size
    },
  });
};
