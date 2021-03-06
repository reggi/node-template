import * as path from 'path';
import * as fs from 'fs';
import {exec} from 'child_process';
import * as util from 'util';
const execAsync = util.promisify(exec);

const COMMIT = 'commit';
const PULL = 'pull';

const defaultIgnore = ['.git', '.template'];

type Any = {};

export interface ConfigJson {
  name: string;
  ignoreKeys: string[];
}

export interface Config {
  source: string;
  ignore: string[];
  json?: ConfigJson[];
}

export class Template {
  static execAsync = execAsync;
  static async readJson(filePath: string) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      return {};
    }
  }
  static async readGitIgnore(filePath: string): Promise<string[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      return content.split('\n').filter(i => i);
    } catch (e) {
      return [];
    }
  }
  static async config(location: string): Promise<Config> {
    const configPath = path.join(location, 'template.json');
    const ignorePath = path.join(location, '.gitignore');
    const config = await Template.readJson(configPath);
    const gitignore = await Template.readGitIgnore(ignorePath);
    if (!config.source) throw new Error('config is missing source');
    const ignoreJson = (config.json || []).map((j: ConfigJson) => j.name);
    const ignore = [
      ...gitignore,
      ...ignoreJson,
      ...defaultIgnore,
      ...(config.ignore || []),
    ];
    return {...config, ignore} as Config;
  }
  static async files(location: string, ignore: string[]) {
    const files: string[] = [];
    const recursive = async (location: string) => {
      const entries = await fs.promises.readdir(location, {
        withFileTypes: true,
      });
      const promises = entries.map(async entry => {
        if (ignore.includes(entry.name)) return;
        const fullLocation = path.join(location, entry.name);
        if (entry.isDirectory()) {
          await recursive(fullLocation);
        } else {
          files.push(fullLocation);
        }
      });
      await Promise.all(promises);
    };
    await recursive(location);
    return files;
  }
  static async rmdir(location: string) {
    const entries = await fs.promises.readdir(location, {withFileTypes: true});
    const promises = entries.map(entry => {
      const fullLocation = path.join(location, entry.name);
      return entry.isDirectory()
        ? Template.rmdir(fullLocation)
        : fs.promises.unlink(fullLocation);
    });
    await Promise.all(promises);
    await fs.promises.rmdir(location);
  }
  static async mkdirp(location: string) {
    location = path.resolve(location);
    const locationSplit = location.split(path.sep);
    return locationSplit
      .map((i, index) => {
        return path.join('/', ...locationSplit.slice(0, index + 1));
      })
      .filter(i => i !== '/')
      .reduce((resolve, segment) => {
        return resolve.then(async () => {
          try {
            await fs.promises.stat(segment);
          } catch (e) {
            await fs.promises.mkdir(segment);
          }
        });
      }, Promise.resolve());
  }
  static async clone(repo: string, location: string) {
    try {
      const templateDir = path.join(location, '.template');
      await Template.rmdir(templateDir);
    } catch (e) {
      // noop
    }
    return execAsync(`git -C ${location} clone ${repo} .template`);
  }
  static templateFile(file: string, location: string) {
    const chopped = file.replace(new RegExp(`^${location}`), '');
    return path.join(location, path.join('.template', chopped));
  }
  static normalFile(
    templateFile: string,
    templateDir: string,
    location: string
  ) {
    const chopped = templateFile.replace(new RegExp(`^${templateDir}`), '');
    return path.join(location, chopped);
  }
  static omit(keys: string[], obj: {[key: string]: Any}): {[key: string]: Any} {
    return Object.keys(obj).reduce((prev, curr) => {
      const value = obj[curr];
      if (!keys.includes(curr)) return {...prev, [curr]: value};
      return prev;
    }, {});
  }
  static deepMerge(target: {[key: string]: Any}, source: {[key: string]: Any}) {
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object) {
        Object.assign(
          source[key],
          Template.deepMerge(target[key], source[key])
        );
      }
    }
    // Join `target` and modified `source`
    Object.assign(target, source);
    return target;
  }
  static async mergeJson(json: Config['json'], location: string, cmd: string) {
    const jsonFiles = json || [];
    const promises = jsonFiles.map(async jsonFile => {
      const {ignoreKeys} = jsonFile;
      const file = path.join(location, jsonFile.name);
      const templateFile = Template.templateFile(file, location);
      const fileJSON = await Template.readJson(file);
      const templateFileJSON = await Template.readJson(templateFile);
      const iFileJSON = Template.omit(ignoreKeys, fileJSON);
      const iTemplateFileJSON = Template.omit(ignoreKeys, templateFileJSON);
      if (cmd === COMMIT) {
        const json = Template.deepMerge(templateFileJSON, iFileJSON);
        const output = JSON.stringify(json, null, 2);
        await Template.mkdirp(path.dirname(templateFile));
        await fs.promises.writeFile(templateFile, output, 'utf-8');
      }
      if (cmd === PULL) {
        const json = Template.deepMerge(fileJSON, iTemplateFileJSON);
        const output = JSON.stringify(json, null, 2);
        await Template.mkdirp(path.dirname(file));
        await fs.promises.writeFile(file, output, 'utf-8');
      }
    });
    await Promise.all(promises);
  }
  static async main(location: string, cmd: string) {
    const {source, ignore, json} = await Template.config(location);
    await Template.clone(source, location);
    await Template.mergeJson(json, location, cmd);
    if (cmd === COMMIT) {
      const files = await Template.files(location, ignore);
      const promises = files.map(async file => {
        const templateFile = Template.templateFile(file, location);
        await Template.mkdirp(path.dirname(templateFile));
        await fs.promises.copyFile(file, templateFile);
      });
      return await Promise.all(promises);
    }
    if (cmd === PULL) {
      const templateDir = path.join(location, '.template');
      const files = await Template.files(templateDir, ignore);
      const promises = files.map(async templateFile => {
        const file = Template.normalFile(templateFile, templateDir, location);
        await Template.mkdirp(path.dirname(file));
        await fs.promises.copyFile(templateFile, file);
      });
      return Promise.all(promises);
    }
    throw new Error('invalid sub-command');
  }
  static async cli(process: NodeJS.Process) {
    const location = process.cwd();
    const cmd = process.argv.slice(2)[0];
    try {
      await Template.main(location, cmd);
      process.exit(0);
    } catch (e) {
      process.stderr.write(e.message + '\n');
      process.exit(1);
    }
  }
}
