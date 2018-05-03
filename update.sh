#!/bin/bash

DIR_NAME="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )";
FUNCTION_NAME=`basename $DIR_NAME`;
S3_BUCKET=com.brave.research.lambda-funcs;
S3_KEY=$FUNCTION_NAME.zip;

# First build a new bundle / zip of the function
npm run bundle;

# New upload the new function to S3
aws s3 cp lambda.zip  s3://$S3_BUCKET/$S3_KEY;

# And then update the function definition
aws lambda update-function-code --function-name $FUNCTION_NAME --s3-bucket $S3_BUCKET --s3-key $S3_KEY;
