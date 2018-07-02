all: lambda
TMP_WORKSPACE := /tmp/brave-abp-measurer
TMP_RESROUCES := $(TMP_WORKSPACE)/resources
CHROME_DRIVER_URL := https://chromedriver.storage.googleapis.com/2.37/chromedriver_linux64.zip
CHROME_HEADLESS_URL := https://github.com/adieuadieu/serverless-chrome/releases/download/v1.0.0-38/stable-headless-chromium-amazonlinux-2017-03.zip

lambda: clean
	rm -Rf $(TMP_WORKSPACE);
	mkdir $(TMP_WORKSPACE);
	cp -R * $(TMP_WORKSPACE)/;
	rm -Rf $(TMP_WORKSPACE)/node_modules/aws-sdk;
	find $(TMP_WORKSPACE) -type d -name depot_tools | xargs rm -Rf;
	rm -Rf $(TMP_WORKSPACE)/node_modules/ad-block/test;
	rm -Rf $(TMP_WORKSPACE)/node_modules/ad-block/node_modules;
	rm -Rf $(TMP_WORKSPACE)/node_modules/ad-block/vendor;
	rm -Rf $(TMP_WORKSPACE)/node_modules/eslint;
	rm -Rf $(TMP_WORKSPACE)/node_modules/eslint-*;
	rm -Rf $(TMP_WORKSPACE)/node_modules/pluralize;
	rm -Rf $(TMP_WORKSPACE)/node_modules/bloom-filter-cpp;
	rm -Rf $(TMP_WORKSPACE)/node_modules/regexpp;
	rm -Rf $(TMP_WORKSPACE)/node_modules/ajv/dist/regenerator.min.js;
	rm -Rf $(TMP_WORKSPACE)/node_modules/core-js/web;
	rm -Rf $(TMP_WORKSPACE)/node_modules/core-js/modules;
	rm -Rf $(TMP_WORKSPACE)/node_modules/core-js/fn;
	rm -Rf $(TMP_WORKSPACE)/node_modules/core-js/client;
	rm -Rf $(TMP_WORKSPACE)/node_modules/core-js/stage;
	rm -Rf $(TMP_WORKSPACE)/node_modules/nan;
	find $(TMP_WORKSPACE)/node_modules -type f -name "*.md" -delete;
	find $(TMP_WORKSPACE)/node_modules -type d -name "test" | xargs rm -Rf;
	rm $(TMP_WORKSPACE)/Makefile;
	rm $(TMP_WORKSPACE)/*.json;
	mkdir $(TMP_WORKSPACE)/resources/;
	curl -L $(CHROME_DRIVER_URL) --output $(TMP_WORKSPACE)/resources/chromedriver.zip;
	unzip $(TMP_WORKSPACE)/resources/chromedriver.zip -d $(TMP_WORKSPACE)/resources/;
	rm $(TMP_WORKSPACE)/resources/chromedriver.zip;
	curl -L $(CHROME_HEADLESS_URL) --output $(TMP_WORKSPACE)/resources/chromium_headless.zip;
	unzip $(TMP_WORKSPACE)/resources/chromium_headless.zip -d $(TMP_WORKSPACE)/resources/;
	rm $(TMP_WORKSPACE)/resources/chromium_headless.zip;
	cd $(TMP_WORKSPACE) && zip -r lambda.zip *;
	cp $(TMP_WORKSPACE)/lambda.zip lambda.zip;

clean:
	test -f lambda.zip && rm lambda.zip || echo "clean";
