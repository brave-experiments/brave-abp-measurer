#!/bin/bash
TMP_DIR=/tmp/brave-abp-measurer-run
test -d $TMP_DIR && rm -Rf $TMP_DIR && mkdir $TMP_DIR;

if [[ -f lambda.zip ]]; then
    rm lambda.zip;
fi;
npm run bundle;
unzip lambda.zip -d $TMP_DIR;
# '{\
#     "domain": "www.cnn.com",\
#     "debug": true,\
#     "filtersUrls": [\
#         "https://easylist.to/easylist/easylist.txt",\
#         "https://easylist.to/easylist/easyprivacy.txt",\
#         "https://raw.githubusercontent.com/brave/adblock-lists/master/ublock-unbreak.txt",\
#         "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt",\
#         "https://raw.githubusercontent.com/brave/adblock-lists/master/coin-miners.txt"\
#     ],\
#     "tags": [\
#         "docker-test"\
#     ],\
#     "batch": "1f366690-6e84-4a2b-b200-8e37b8c9d24a"\
# }'
docker run -it -v $TMP_DIR:/var/task lambci/lambda:nodejs8.10 lambda.dispatch '{"domain": "www.cnn.com","debug": true,"filtersUrls": [ "https://easylist.to/easylist/easylist.txt", "https://easylist.to/easylist/easyprivacy.txt", "https://raw.githubusercontent.com/brave/adblock-lists/master/ublock-unbreak.txt", "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt", "https://raw.githubusercontent.com/brave/adblock-lists/master/coin-miners.txt"], "tags": [ "docker-test" ], "batch": "1f366690-6e84-4a2b-b200-8e37b8c9d24a" }'
