import fs from "fs";
import fsPath from "path";
import ts from "typescript";
import { Dependency } from "webpack";

const t1 = Date.now();

const projectRoot = "/Users/oleavr/src/hello-frida";
const nodeModulesDir = fsPath.join(projectRoot, "node_modules");
const libDir = "/Users/oleavr/src/frida-compile/node_modules/typescript/lib";

const output = new Map<string, string>();
const fileCache = new Map<string, string>();
const pendingModules = new Set<string>();
const processedModules = new Set<string>();

class FridaHost implements ts.System, ts.ParseConfigFileHost {
    args = [];
    newLine = "\n";
    useCaseSensitiveFileNames = true;

    write(s: string): void {
        console.log("TODO: write()");
    }

    writeOutputIsTTY(): boolean {
        console.log("TODO: writeOutputIsTTY()");
        return true;
    }

    readFile(path: string, encoding?: string): string | undefined {
        if (fileCache.has(path)) {
            return fileCache.get(path);
        }

        let result: string | undefined;
        try {
            result = fs.readFileSync(path, { encoding: "utf-8" });
        } catch (e) {
            result = undefined;
        }

        if (result !== undefined) {
            fileCache.set(path, result);

            if (fsPath.basename(path) === "package.json") {
                const pkgDir = fsPath.dirname(path);
                const pkgMeta = JSON.parse(result);
                const pkgMain = pkgMeta.main ?? "index.js";
                const pkgEntrypoint = fsPath.join(pkgDir, pkgMain);
                pendingModules.add(pkgEntrypoint);
                processedModules.add(pkgMeta.name);
            }
        }

        //console.log(`readFile("${path}") => ${(result !== undefined) ? "success" : "failure"}`);

        return result;
    }

    getFileSize(path: string): number {
        console.log("TODO: getFileSize()");
        return 0;
    }

    writeFile(path: string, data: string, writeByteOrderMark?: boolean): void {
        if (path.startsWith(projectRoot)) {
            output.set(path.substr(projectRoot.length), data);
        } else {
            console.log("writeFile() ignoring:", path);
        }
    }

    watchFile(path: string, callback: ts.FileWatcherCallback, pollingInterval?: number, options?: ts.WatchOptions): ts.FileWatcher {
        console.log("TODO: watchFile()");
        throw new Error("Not implemented");
    }

    watchDirectory(path: string, callback: ts.DirectoryWatcherCallback, recursive?: boolean, options?: ts.WatchOptions): ts.FileWatcher {
        console.log("TODO: watchDirectory()");
        throw new Error("Not implemented");
    }

    resolvePath(path: string): string {
        console.log("TODO: resolvePath()");
        return path;
    }

    fileExists(path: string): boolean {
        try {
            const st = fs.statSync(path);
            return !st.isDirectory();
        } catch (e) {
            return false;
        }
    }

    directoryExists(path: string): boolean {
        try {
            const st = fs.statSync(path);
            return st.isDirectory();
        } catch (e) {
            return false;
        }
    }

    createDirectory(path: string): void {
        console.log("TODO: createDirectory()");
    }

    getExecutingFilePath(): string {
        console.log("TODO: getExecutingFilePath()");
        return fsPath.join(libDir, "typescript.js");
    }

    getCurrentDirectory(): string {
        console.log("TODO: getCurrentDirectory()");
        return projectRoot;
    }

    getDirectories(path: string): string[] {
        console.log("TODO: getDirectories()");
        return [];
    }

    readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[] {
        console.log(`TODO: readDirectory("${path}")`);
        if (extensions !== undefined) {
            console.log(`\textensions: [ ${extensions.join(", ")} ]`);
        }
        if (exclude !== undefined) {
            console.log(`\texclude: [ ${exclude.join(", ")} ]`);
        }
        if (include !== undefined) {
            console.log(`\tinclude: [ ${include.join(", ")} ]`);
        }
        if (depth !== undefined) {
            console.log(`\tdepth: ${depth}`);
        }
        return [];
    }

    getModifiedTime(path: string): Date | undefined {
        console.log("TODO: getModifiedTime()");
        return undefined;
    }

    setModifiedTime(path: string, time: Date): void {
        console.log("TODO: setModifiedTime()");
    }

    deleteFile(path: string): void {
        console.log("TODO: deleteFile()");
    }

    createHash(data: string): string {
        console.log("TODO: createHash");
        return "xxx";
    }

    createSHA256Hash(data: string): string {
        console.log("TODO: createSHA256Hash");
        return "xxx";
    }

    getMemoryUsage(): number {
        console.log("TODO: getMemoryUsage");
        return Frida.heapSize;
    }

    exit(exitCode?: number): void {
        console.log("TODO: exit");
    }

    realpath(path: string): string {
        console.log("TODO: realpath");
        return path;
    }

    setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): any {
        return setTimeout(callback);
    }

    clearTimeout(timeoutId: any): void {
        return clearTimeout(timeoutId);
    }

    clearScreen(): void {
        console.log("TODO: clearScreen");
    }

    base64decode(input: string): string {
        console.log("TODO: base64decode");
        return "yyy";
    }

    base64encode(input: string): string {
        console.log("TODO: base64encode");
        return "zzz";
    }

    onUnRecoverableConfigFileDiagnostic(diagnostic: ts.Diagnostic) {
    }
}

const host = new FridaHost();

ts.sys = host;

const defaultOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    allowJs: true,
    strict: true
};

const options = ts.getParsedCommandLineOfConfigFile(fsPath.join(projectRoot, "tsconfig.json"), defaultOptions, host)!.options;
options.noImplicitUseStrict = true;
delete options.noEmit;

console.log(JSON.stringify(options));

const program = ts.createProgram({
    rootNames: [fsPath.join(projectRoot, "agent", "index.ts")],
    options
});

program.emit();
console.log("Output:", JSON.stringify(Object.fromEntries(output)));

while (pendingModules.size > 0) {
    const entry = pendingModules.values().next().value;
    pendingModules.delete(entry);
    processedModules.add(entry);

    let modPath: string;
    if (fsPath.isAbsolute(entry)) {
        modPath = entry;
    } else {
        const pkgPath = fsPath.join(nodeModulesDir, entry);

        const rawPkgMeta = host.readFile(fsPath.join(pkgPath, "package.json"));
        if (rawPkgMeta !== undefined) {
            const pkgMeta = JSON.parse(rawPkgMeta);
            const pkgMain = pkgMeta.main ?? "index.js";
            const pkgEntrypoint = fsPath.join(pkgPath, pkgMain);

            modPath = pkgEntrypoint;
        } else if (entry.indexOf("/") !== -1) {
            modPath = pkgPath;
        } else {
            console.log("Assuming built-in:", entry)
            continue;
        }
    }

    if (modPath.endsWith(".json")) {
        console.log("Ignoring JSON:", entry);
        continue;
    }

    if (host.directoryExists(modPath)) {
        modPath = fsPath.join(modPath, "index.js");
    }

    let modCode = host.readFile(modPath);
    if (modCode === undefined) {
        modPath += ".js";
        modCode = host.readFile(modPath);
        if (modCode === undefined) {
            throw new Error(`Unable to resolve: ${entry}`);
        }
    }

    const sourceFile = ts.createSourceFile(modPath, modCode, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    processJSModule(modPath, sourceFile);
}

function processJSModule(path: string, mod: ts.Node) {
    const moduleDir = fsPath.dirname(path);
    ts.forEachChild(mod, visit);

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            visitCallExpression(node);
        } else {
            ts.forEachChild(node, visit);
        }
    }

    function visitCallExpression(call: ts.CallExpression) {
        const expr: ts.LeftHandSideExpression = call.expression;
        if (!ts.isIdentifier(expr)) {
            return;
        }
        if (expr.escapedText !== "require") {
            return;
        }

        const args = call.arguments;
        if (args.length !== 1) {
            return;
        }

        const arg = args[0];
        if (!ts.isStringLiteral(arg)) {
            return;
        }

        const depName = arg.text;
        const depPath = resolveModule(depName);
        if (!processedModules.has(depPath)) {
            pendingModules.add(depPath);
        }
    }

    function resolveModule(name: string): string {
        if (name.startsWith(".")) {
            return fsPath.join(moduleDir, name);
        } else {
            return name;
        }
    }
}

const t2 = Date.now();
console.log(`Took ${t2 - t1} ms`);
