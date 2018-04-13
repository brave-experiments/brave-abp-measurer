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
	mkdir $(TMP_WORKSPACE)/resources/;
	curl -L $(CHROME_DRIVER_URL) --output $(TMP_WORKSPACE)/resources/chromedriver.zip;
	curl -L $(CHROME_HEADLESS_URL) --output $(TMP_WORKSPACE)/resources/chromium_headless.zip;
	cd $(TMP_WORKSPACE) && zip -r lambda.zip *;
	cp $(TMP_WORKSPACE)/lambda.zip lambda.zip;
	# rm -Rf $(TMP_WORKSPACE);

clean:
	@if [[ -f lambda.zip ]]; then \
		rm lambda.zip;\
	fi;
