all: dist/compiler.js

dist/compiler.js: ext/TypeScript/built/local/typescript.js ext/cjstoesm/dist/esm/index.js
	npm run build

ext/TypeScript/built/local/typescript.js: node_modules/.bin/terser
	cd ext/TypeScript \
		&& npm install \
		&& npm run build:compiler
	mv $@ $@_
	node_modules/.bin/terser \
		-c -m \
		--ecma 2020 \
		--module \
		-o $@ \
		$@_

ext/cjstoesm/dist/esm/index.js: node_modules/.bin/terser
	cd ext/cjstoesm \
		&& npm install \
		&& npm run build
	sed -e "s,from 'typescript',from '../../../TypeScript/built/local/typescript.js',g" $@ > $@_
	rm $@
	node_modules/.bin/terser \
		-c -m \
		--ecma 2020 \
		--module \
		-o $@ \
		$@_

node_modules/.bin/terser:
	npm install

.PHONY: all
