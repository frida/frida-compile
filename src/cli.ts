import { program } from "commander";
import { build } from "./index.js";

async function main() {
    program
    .usage("[options] <module>")
    .requiredOption("-o, --output <file>", "write output to <file>");

    program.parse();

    const opts = program.opts();

    await build(process.cwd(), program.args[0], opts.output);
}

main()
    .catch(e => {
        console.error(e);
        process.exitCode = 1;
    });