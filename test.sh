#!/bin/bash
TMP_DIR=/tmp/brave-abp-measurer-run
test -d $TMP_DIR && rm -Rf $TMP_DIR && mkdir $TMP_DIR;

if [[ ! -f lambda.zip ]]; then
    npm run bundle;
fi;
unzip lambda.zip -d $TMP_DIR;
docker run -it -v $TMP_DIR:/var/task lambci/lambda:nodejs8.10 lambda.dispatch '{"domain": "www.cnn.com", "debug": true, "filtersUrl":"https://easylist.to/easylist/easylist.txt", "tags": ["docker-test"], "batch": "1f366690-6e84-4a2b-b200-8e37b8c9d24a"}'
