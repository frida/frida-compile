import fs from "fs";
import fsPath from "path";
import ts from "../../ext/typescript.js";

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
    }

    writeOutputIsTTY(): boolean {
        return true;
    }

    readFile(path: string, encoding?: string): string | undefined {
        if (fileCache.has(path)) {
            return fileCache.get(path);
        }

        let result: string | undefined;
        try {
            result = File.readAllText(path);
        } catch (e) {
            result = undefined;
        }

        if (result !== undefined) {
            fileCache.set(path, result);
        }

        return result;
    }

    getFileSize(path: string): number {
        throw new Error("not implemented");
    }

    writeFile(path: string, data: string, writeByteOrderMark?: boolean): void {
        File.writeAllText(path, data);
    }

    watchFile(path: string, callback: ts.FileWatcherCallback, pollingInterval?: number, options?: ts.WatchOptions): ts.FileWatcher {
        throw new Error("not implemented");
    }

    watchDirectory(path: string, callback: ts.DirectoryWatcherCallback, recursive?: boolean, options?: ts.WatchOptions): ts.FileWatcher {
        throw new Error("not implemented");
    }

    resolvePath(path: string): string {
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
        throw new Error("not implemented");
    }

    getExecutingFilePath(): string {
        return fsPath.join(this.libDir, "typescript.js");
    }

    getCurrentDirectory(): string {
        return this.projectRoot;
    }

    getDirectories(path: string): string[] {
        return [];
    }

    readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[] {
        return [];
    }

    getModifiedTime(path: string): Date | undefined {
        return undefined;
    }

    setModifiedTime(path: string, time: Date): void {
    }

    deleteFile(path: string): void {
    }

    createHash(data: string): string {
        return this.createSHA256Hash(data);
    }

    createSHA256Hash(data: string): string {
        return Checksum.compute("sha256", data);
    }

    getMemoryUsage(): number {
        return Frida.heapSize;
    }

    exit(exitCode?: number): void {
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
    }

    base64decode(input: string): string {
        throw new Error("not implemented");
    }

    base64encode(input: string): string {
        throw new Error("not implemented");
    }
}
