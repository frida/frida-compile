import fs from "fs";
import fsPath from "path";
import sjcl from "sjcl";
import ts from "../ext/TypeScript/built/local/typescript.js";

const fileCache = new Map<string, string>();

export class FridaSystem implements ts.System {
    args = [];
    newLine = "\n";
    useCaseSensitiveFileNames = true;

    constructor(
        private projectRoot: string,
        private libDir: string) {
    }

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
        }

        //console.log(`readFile("${path}") => ${(result !== undefined) ? "success" : "failure"}`);

        return result;
    }

    getFileSize(path: string): number {
        console.log("TODO: getFileSize()");
        return 0;
    }

    writeFile(path: string, data: string, writeByteOrderMark?: boolean): void {
        console.log("writeFile() ignoring:", path);
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
        return fsPath.join(this.libDir, "typescript.js");
    }

    getCurrentDirectory(): string {
        return this.projectRoot;
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
        return this.createSHA256Hash(data);
    }

    createSHA256Hash(data: string): string {
        const bits = sjcl.hash.sha256.hash(data);
        return sjcl.codec.hex.fromBits(bits);
    }

    getMemoryUsage(): number {
        return Frida.heapSize;
    }

    exit(exitCode?: number): void {
        console.log("TODO: exit");
    }

    realpath(path: string): string {
        return path;
    }

    getEnvironmentVariable(name: string): string {
        return "";
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
}