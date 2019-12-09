import {
  BuilderContext,
  createBuilder,
  BuilderOutput,
  targetFromTargetString,
  scheduleTargetAndForget
} from '@angular-devkit/architect';
import { JsonObject } from '@angular-devkit/core';
import { Observable, of, from } from 'rxjs';
import { concatMap, tap, mergeMap, map } from 'rxjs/operators';
import { stripIndents } from '@angular-devkit/core/src/utils/literals';
import { ChildProcess, fork } from 'child_process';
import { ServerlessBuildEvent, BuildServerlessBuilderOptions } from '../build/build.impl';
import * as isBuiltinModule from 'is-builtin-module';
import * as _ from 'lodash';
import { ServerlessWrapper } from '../../utils/serverless';
import * as path from 'path';
import { packager } from '../../utils/packagers/index';
import { Yarn } from '../../utils/packagers/yarn';
import { NPM } from '../../utils/packagers/npm';
try {
  require('dotenv').config();
} catch (e) { }

export const enum InspectType {
  Inspect = 'inspect',
  InspectBrk = 'inspect-brk'
}

export interface ServerlessDeployBuilderOptions extends BuildServerlessBuilderOptions {
  inspect: boolean | InspectType;
  waitUntilTargets: string[];
  buildTarget: string;
  host: string;
  port: number;
  watch: boolean;
  args: string[];
  package: string;
}

export default createBuilder<ServerlessDeployBuilderOptions & JsonObject>(serverlessExecutionHandler);
let subProcess: ChildProcess = null;

export function serverlessExecutionHandler(
  options: JsonObject & ServerlessDeployBuilderOptions,
  context: BuilderContext
): Observable<BuilderOutput> {
  // build into output path before running serverless offline.

  return ServerlessWrapper.init(options, context).pipe(
    mergeMap(() => {
      return startBuild(options, context);
    }),
    concatMap((event: ServerlessBuildEvent) => {
      if (event.success) {
        ServerlessWrapper.serverless.cli.log("getting external modules")
        var externals = getExternalModules(event.webpackStats);
        const originPackageJsonPath = path.join('./', 'package.json');
        const packageJsonPath = path.join(options.package, 'package.json');
        const packageJson = ServerlessWrapper.serverless.utils.readFileSync(originPackageJsonPath);
        const prodModules = getProdModules(externals, packageJson, originPackageJsonPath, []);
        createPackageJson(prodModules, packageJsonPath, originPackageJsonPath);
            // run packager to  install node_modules
            let packagerProcess: ChildProcess = null;
            if (packager("yarn")) {
              packagerProcess = Yarn.install(options.package, {});
            } else if (packager("npm")) {
              packagerProcess = NPM.install(options.package);
            }
            else {
              throw Error("No Packager to process package.json, please install npm or yarn");
            }

            return from(new Promise<BuilderOutput>(() => {
                packagerProcess.stdout.on('data', data => {
                  return Promise.resolve({ success: false, data: `child exited with error ${data}` });
                });
                packagerProcess.stderr.on('data', error => {
                  return Promise.resolve({ success: false, error: `child exited with error ${error}` });

                });
                packagerProcess.on('exit', code => {
                  return Promise.resolve({ success: false, error: `child exited with code ${code}` });
                });
                packagerProcess.on('close', () => {
                  ServerlessWrapper.serverless.config.servicePath = "dist/apps/api/lambda.subscription";
                  ServerlessWrapper.serverless.processedInput = { commands: ['deploy'] , options: getExecArgv(options) };
                  ServerlessWrapper.serverless.run();
                  return Promise.resolve({ success: true });
                });
              }
            ));
      }
      else {
        context.logger.error(
          'There was an error with the build. See above.'
        );
        context.logger.info(`${event.outfile} was not restarted.`);
        return of(event);
      }
    })
  );
}

function startBuild(
  options: ServerlessDeployBuilderOptions,
  context: BuilderContext
): Observable<ServerlessBuildEvent> {
  const target = targetFromTargetString(options.buildTarget);
  return from(
    Promise.all([
      context.getTargetOptions(target),
      context.getBuilderNameForTarget(target)
    ]).then(([options, builderName]) =>
      context.validateOptions(options, builderName)
    )
  ).pipe(
    tap(options => {
      if (options.optimization) {
        context.logger.info(stripIndents`
              ************************************************
              This is a custom wrapper of serverless deploy
              ************************************************`);
      }
    }),
    concatMap(
      () =>
        scheduleTargetAndForget(context, target, {
          watch: true
        }) as unknown as Observable<ServerlessBuildEvent>
    )
  );
}

function getExecArgv(options: ServerlessDeployBuilderOptions) {
  const args = [];
  for (var key in options) {
    if (options.hasOwnProperty(key)) {
      if (options[key] !== undefined && key !== 'buildTarget' && key !== 'package') {
        args.push(`--${key}=${options[key]}`);
      }
    }
  }

  return args;
}

function createPackageJson(externalModules, packageJsonPath, pathToPackageRoot) {
  const compositePackage = _.defaults({
    name: ServerlessWrapper.serverless.service.service,
    version: '1.0.0',
    description: `Packaged externals for ${ServerlessWrapper.serverless.service.service}`,
    private: true,
    scripts: {
      "package-yarn": "yarn",
      "package-npm": "npm install"
    }
  }, {});
  addModulesToPackageJson(externalModules, compositePackage, pathToPackageRoot); // for rebase , relPath
  ServerlessWrapper.serverless.utils.writeFileSync(packageJsonPath, JSON.stringify(compositePackage, null, 2));
}

function getProdModules(externalModules, packageJson, packagePath, forceExcludes) {
  const prodModules = [];
  // only process the module stated in dependencies section
  if (!packageJson.dependencies) {
    return [];
  }
  // Get versions of all transient modules
  _.forEach(externalModules, module => {
    let moduleVersion = packageJson.dependencies[module.external];
    if (moduleVersion) {
      prodModules.push(`${module.external}@${moduleVersion}`);
      // Check if the module has any peer dependencies and include them too
      try {
        const modulePackagePath = path.join(
          path.dirname(path.join(process.cwd(), packagePath)),
          'node_modules',
          module.external,
          'package.json'
        );
        console.log(modulePackagePath);
        const peerDependencies = require(modulePackagePath).peerDependencies;
        if (!_.isEmpty(peerDependencies)) {
          this.options.verbose && ServerlessWrapper.serverless.cli.log(`Adding explicit peers for dependency ${module.external}`);
          const peerModules = getProdModules.call(this, _.map(peerDependencies, (value, key) => ({ external: key })), packagePath, forceExcludes);
          Array.prototype.push.apply(prodModules, peerModules);
        }
      } catch (e) {
        ServerlessWrapper.serverless.cli.log(`WARNING: Could not check for peer dependencies of ${module.external}`);
      }
    } else {
      // if (!packageJson.devDependencies || !packageJson.devDependencies[module.external]) {
      //   // Add transient dependencies if they appear not in the service's dev dependencies
      //   const originInfo = _.get(dependencyGraph, 'dependencies', {})[module.origin] || {};
      //   moduleVersion = _.get(_.get(originInfo, 'dependencies', {})[module.external], 'version');
      //   if (!moduleVersion) {
      //     ServerlessWrapper.serverless.cli.log(`WARNING: Could not determine version of module ${module.external}`);
      //   }
      //   prodModules.push(moduleVersion ? `${module.external}@${moduleVersion}` : module.external);
      // } else 
      if (packageJson.devDependencies && packageJson.devDependencies[module.external] && !_.includes(forceExcludes, module.external)) {
        // To minimize the chance of breaking setups we whitelist packages available on AWS here. These are due to the previously missing check
        // most likely set in devDependencies and should not lead to an error now.
        const ignoredDevDependencies = ['aws-sdk'];
        if (!_.includes(ignoredDevDependencies, module.external)) {
          // Runtime dependency found in devDependencies but not forcefully excluded
          ServerlessWrapper.serverless.cli.log(`ERROR: Runtime dependency '${module.external}' found in devDependencies. Move it to dependencies or use forceExclude to explicitly exclude it.`);
          throw new ServerlessWrapper.serverless.classes.Error(`Serverless-webpack dependency error: ${module.external}.`);
        }
        this.options.verbose && ServerlessWrapper.serverless.cli.log(`INFO: Runtime dependency '${module.external}' found in devDependencies. It has been excluded automatically.`);
      }
    }
  });
  return prodModules;
}

function addModulesToPackageJson(externalModules, packageJson, pathToPackageRoot) { // , pathToPackageRoot
  _.forEach(externalModules, externalModule => {
    const splitModule = _.split(externalModule, '@');
    // If we have a scoped module we have to re-add the @
    if (_.startsWith(externalModule, '@')) {
      splitModule.splice(0, 1);
      splitModule[0] = '@' + splitModule[0];
    }
    let moduleVersion = _.join(_.tail(splitModule), '@');
    // We have to rebase file references to the target package.json
    moduleVersion = rebaseFileReferences(pathToPackageRoot, moduleVersion);
    packageJson.dependencies = packageJson.dependencies || {};
    packageJson.dependencies[_.first(splitModule)] = moduleVersion;
  });
}

function rebaseFileReferences(pathToPackageRoot, moduleVersion) {
  if (/^(?:file:[^/]{2}|\.\/|\.\.\/)/.test(moduleVersion)) {
    const filePath = _.replace(moduleVersion, /^file:/, '');
    return _.replace(`${_.startsWith(moduleVersion, 'file:') ? 'file:' : ''}${pathToPackageRoot}/${filePath}`, /\\/g, '/');
  }

  return moduleVersion;
}

function getExternalModules(stats: any) {
  if (!stats.chunks) {
    return [];
  }
  const externals = new Set();
  for (const chunk of stats.chunks) {
    if (!chunk.modules) {
      continue;
    }

    // Explore each module within the chunk (built inputs):
    for (const module of chunk.modules) {
      if (isExternalModule(module)) {
        externals.add({
          origin: module.issuer,
          external: getExternalModuleName(module)
        });
      }
    }
  }
  return Array.from(externals);
}

function getExternalModuleName(module) {
  const path = /^external "(.*)"$/.exec(module.identifier)[1];
  const pathComponents = path.split('/');
  const main = pathComponents[0];

  // this is a package within a namespace
  if (main.charAt(0) == '@') {
    return `${main}/${pathComponents[1]}`;
  }

  return main;
}

function isExternalModule(module) {
  return _.startsWith(module.identifier, 'external ') && !isBuiltinModule(getExternalModuleName(module));
}