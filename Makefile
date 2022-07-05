all: dist/compiler.js

dist/compiler.js: ext/typescript.js ext/cjstoesm.js
	npm run build

ext/typescript.js: node_modules/.bin/terser
	cd ext/TypeScript \
		&& npm install \
		&& node_modules/.bin/gulp services
	( \
		cat ext/TypeScript/built/local/typescript.js; \
		echo "export default ts;"; \
	) > $@_
	cp ext/TypeScript/built/local/typescript.d.ts ext/
	cp ext/TypeScript/built/local/lib.es*.d.ts ext/
	node_modules/.bin/terser \
		-c -m \
		--ecma 2020 \
		--module \
		-o $@ \
		--define process.env.FRIDA_COMPILE=true \
		$@_
	rm $@_

ext/cjstoesm.js: node_modules/.bin/terser
	cd ext/cjstoesm \
		&& npm install \
		&& npm run build
	sed -e 's/import { MaybeArray } from "helpertypes";/type MaybeArray<T> = T[] | T;/g' \
		ext/cjstoesm/dist/esm/index.d.ts > ext/cjstoesm.d.ts
	sed -e "s,from 'typescript',from './typescript.js',g" \
		ext/cjstoesm/dist/esm/index.js > $@_
	node_modules/.bin/terser \
		-c -m \
		--ecma 2020 \
		--module \
		-o $@ \
		$@_
	rm $@_

node_modules/.bin/terser:
	npm install

.PHONY: all
