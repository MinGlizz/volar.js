import {
	createLanguageService as _createLanguageService,
	type Config,
	type LanguageServiceHost
} from '@volar/language-service';
import type * as monaco from 'monaco-editor-core';
import type * as ts from 'typescript/lib/tsserverlibrary';
import { URI } from 'vscode-uri';

export function createLanguageService(options: {
	workerContext: monaco.worker.IWorkerContext<any>,
	dtsHost?: DtsHost,
	config: Config,
	typescript?: {
		module: typeof import('typescript/lib/tsserverlibrary'),
		compilerOptions: ts.CompilerOptions,
	},
}) {

	const ts = options.typescript?.module;
	const dtsFiles = new Map<string, string | undefined>();
	const config = options.config ?? {};
	const compilerOptions = options.typescript?.compilerOptions ?? {};
	let host = createLanguageServiceHost();
	let languageService = _createLanguageService(
		{ typescript: ts },
		{
			uriToFileName: uri => URI.parse(uri).fsPath.replace(/\\/g, '/'),
			fileNameToUri: fileName => URI.file(fileName).toString(),
			rootUri: URI.file('/'),
		},
		config,
		host,
	);
	let dtsVersion = 0;
	let runningApis = 0;

	const toClear = new Set<typeof languageService>();

	class InnocentRabbit { };

	for (const api in languageService) {

		const isFunction = typeof (languageService as any)[api] === 'function';;
		if (!isFunction) {
			(InnocentRabbit.prototype as any)[api] = () => (languageService as any)[api];
			continue;
		}

		(InnocentRabbit.prototype as any)[api] = async (...args: any[]) => {

			if (!options.dtsHost) {
				return (languageService as any)[api](...args);
			}

			let result;

			try {
				runningApis++;
				let oldVersion = await options.dtsHost.getVersion();
				result = await (languageService as any)[api](...args);
				let newVersion = await options.dtsHost.getVersion();

				while (newVersion !== oldVersion) {
					oldVersion = newVersion;
					if (newVersion !== dtsVersion) {
						dtsVersion = newVersion;
						toClear.add(languageService);
						languageService = _createLanguageService(
							{ typescript: ts },
							{
								rootUri: URI.file('/'),
								uriToFileName: (uri: string) => URI.parse(uri).fsPath.replace(/\\/g, '/'),
								fileNameToUri: (fileName: string) => URI.file(fileName).toString(),
							},
							config,
							host,
						);
					}
					result = await (languageService as any)[api](...args);
					newVersion = await options.dtsHost.getVersion();
				}
			}
			finally {
				runningApis--;
			}

			if (runningApis === 0 && toClear.size > 0) {
				for (const languageService of toClear) {
					languageService.dispose();
				}
				toClear.clear();
			}

			return result;
		};
	}

	return new InnocentRabbit();

	function createLanguageServiceHost() {

		let projectVersion = 0;

		const modelSnapshot = new WeakMap<monaco.worker.IMirrorModel, readonly [number, ts.IScriptSnapshot]>();
		const dtsFileSnapshot = new Map<string, ts.IScriptSnapshot>();
		const modelVersions = new Map<monaco.worker.IMirrorModel, number>();
		const host: LanguageServiceHost = {
			getProjectVersion() {
				const models = options.workerContext.getMirrorModels();
				if (modelVersions.size === options.workerContext.getMirrorModels().length) {
					if (models.every(model => modelVersions.get(model) === model.version)) {
						return projectVersion.toString();
					}
				}
				modelVersions.clear();
				for (const model of options.workerContext.getMirrorModels()) {
					modelVersions.set(model, model.version);
				}
				projectVersion++;
				return projectVersion.toString();
			},
			getScriptFileNames() {
				const models = options.workerContext.getMirrorModels();
				return models.map(model => model.uri.fsPath);
			},
			getScriptVersion(fileName) {
				const model = options.workerContext.getMirrorModels().find(model => model.uri.fsPath === fileName);
				if (model) {
					return model.version.toString();
				}
				const dts = readDtsFile(fileName);
				if (dts) {
					return dts.length.toString();
				}
				return '';
			},
			getScriptSnapshot(fileName) {
				const model = options.workerContext.getMirrorModels().find(model => model.uri.fsPath === fileName);
				if (model) {
					const cache = modelSnapshot.get(model);
					if (cache && cache[0] === model.version) {
						return cache[1];
					}
					const text = model.getValue();
					modelSnapshot.set(model, [model.version, {
						getText: (start, end) => text.substring(start, end),
						getLength: () => text.length,
						getChangeRange: () => undefined,
					}]);
					return modelSnapshot.get(model)?.[1];
				}
				if (dtsFileSnapshot.has(fileName)) {
					return dtsFileSnapshot.get(fileName);
				}
				const dtsFileText = readDtsFile(fileName);
				if (dtsFileText !== undefined) {
					dtsFileSnapshot.set(fileName, {
						getText: (start, end) => dtsFileText.substring(start, end),
						getLength: () => dtsFileText.length,
						getChangeRange: () => undefined,
					});
					return dtsFileSnapshot.get(fileName);
				}
			},
			getCompilationSettings() {
				return compilerOptions;
			},
			getCurrentDirectory() {
				return '/';
			},
			getDefaultLibFileName(options) {
				if (ts) {
					return `/node_modules/typescript/lib/${ts.getDefaultLibFileName(options)}`;
				}
				return '';
			},
			readFile(fileName) {
				const model = options.workerContext.getMirrorModels().find(model => model.uri.fsPath === fileName);
				if (model) {
					return model.getValue();
				}
				return readDtsFile(fileName);
			},
			fileExists(fileName) {
				const model = options.workerContext.getMirrorModels().find(model => model.uri.fsPath === fileName);
				if (model) {
					return true;
				}
				return readDtsFile(fileName) !== undefined;
			},
		};

		return host;
	}

	function readDtsFile(fileName: string) {
		if (!dtsFiles.has(fileName) && options.dtsHost) {
			dtsFiles.set(fileName, undefined);
			readDtsFileAsync(fileName);
		}
		return dtsFiles.get(fileName);
	}

	async function readDtsFileAsync(fileName: string) {
		const text = await options.dtsHost?.readFile(fileName);
		dtsFiles.set(fileName, text);
	}
}

export function createBaseDtsHost(
	cdn: string,
	versions: Record<string, string> = {},
	flat?: (pkg: string, version: string | undefined) => Promise<string[]>,
	onFetch?: (fileName: string, text: string) => void,
) {
	return new CdnDtsHost(cdn, versions, flat, onFetch);
}

export function createJsDelivrDtsHost(
	versions: Record<string, string> = {},
	onFetch?: (fileName: string, text: string) => void,
) {
	return new CdnDtsHost(
		'https://cdn.jsdelivr.net/npm/',
		versions,
		async (pkg, version) => {

			if (!version) {
				const data = await fetchJson<{ version: string | null; }>(`https://data.jsdelivr.com/v1/package/resolve/npm/${pkg}@latest`);
				if (data?.version) {
					version = data.version;
				}
			}
			if (!version) {
				return [];
			}

			const flat = await fetchJson<{ files: { name: string }[]; }>(`https://data.jsdelivr.com/v1/package/npm/${pkg}@${version}/flat`);
			if (!flat) {
				return [];
			}

			return flat.files.map(file => file.name);
		},
		onFetch,
	);
}

export interface DtsHost {
	readFile(fileName: string): Promise<string | undefined> | string | undefined;
	getVersion(): Promise<number>;
}

class CdnDtsHost implements DtsHost {

	files = new Map<string, Promise<string | undefined> | string | undefined>();
	flatResult = new Map<string, Promise<string[]>>();
	lastUpdateFilesSize = 0;

	constructor(
		public cdn: string,
		public versions: Record<string, string> = {},
		public flat?: (pkg: string, version: string | undefined) => Promise<string[]>,
		public onFetch?: (fileName: string, text: string) => void,
	) { }

	async getVersion() {
		while (this.files.size !== this.lastUpdateFilesSize) {
			const newFileSize = this.files.size;
			await Promise.all(this.files.values());
			if (newFileSize > this.lastUpdateFilesSize) {
				this.lastUpdateFilesSize = newFileSize;
			}
		}
		return this.files.size;
	}

	readFile(fileName: string) {
		if (
			fileName.startsWith('/node_modules/')
			// ignore .js because it's no help for intellisense
			&& (fileName.endsWith('.d.ts') || fileName.endsWith('/package.json'))
		) {
			if (!this.files.has(fileName)) {
				this.files.set(fileName, this.fetchFile(fileName));
			}
			return this.files.get(fileName);
		}
		return undefined;
	}

	async fetchFile(fileName: string) {
		if (this.flat) {
			let pkgName = fileName.split('/')[2];
			if (pkgName.startsWith('@')) {
				pkgName += '/' + fileName.split('/')[3];
			}
			if (pkgName.endsWith('.d.ts') || pkgName.endsWith('/node_modules')) {
				return undefined;
			}
			// hard code for known invalid package
			if (pkgName.startsWith('@typescript/') || pkgName.startsWith('@types/typescript__')) {
				return undefined;
			}

			// don't check @types the original package already having types
			if (pkgName.startsWith('@types/')) {
				let originalPkgName = pkgName.slice('@types/'.length);
				if (originalPkgName.indexOf('__') >= 0) {
					originalPkgName = '@' + originalPkgName.replace('__', '/');
				}
				const packageJson = await this.readFile(`/node_modules/${originalPkgName}/package.json`);
				if (packageJson) {
					const packageJsonObj = JSON.parse(packageJson);
					if (packageJsonObj.types || packageJsonObj.typings) {
						return undefined;
					}
					const indexDts = await this.readFile(`/node_modules/${originalPkgName}/index.d.ts`);
					if (indexDts) {
						return undefined;
					}
				}
			}

			if (!this.flatResult.has(pkgName)) {
				this.flatResult.set(pkgName, this.flat(pkgName, this.versions[pkgName]));
			}

			const flat = await this.flatResult.get(pkgName)!;
			const include = flat.includes(fileName.slice(`/node_modules/${pkgName}`.length));
			if (!include) {
				return undefined;
			}
		}

		const requestFileName = this.resolveRequestFileName(fileName);
		const url = this.cdn + requestFileName.slice('/node_modules/'.length);

		return await fetchText(url);
	}

	resolveRequestFileName(fileName: string) {
		for (const [key, version] of Object.entries(this.versions)) {
			if (fileName.startsWith(`/node_modules/${key}/`)) {
				fileName = fileName.replace(`/node_modules/${key}/`, `/node_modules/${key}@${version}/`);
				return fileName;
			}
		}
		return fileName;
	}
}

async function fetchText(url: string) {
	try {
		const res = await fetch(url);
		if (res.status === 200) {
			return await res.text();
		}
	} catch {
		// ignore
	}
}

async function fetchJson<T>(url: string) {
	try {
		const res = await fetch(url);
		if (res.status === 200) {
			return await res.json() as T;
		}
	} catch {
		// ignore
	}
}
