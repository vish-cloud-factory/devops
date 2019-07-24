# S3 Static Website Automated Deployments

Automate deployments to an S3 Static Website whenever code is committed to a particular branch in your CodeCommit repo. 

There are simpler ways in which this could be achieved, e.g. http://stackoverflow.com/questions/32530352/best-strategy-to-deploy-static-site-to-s3-on-github-push. However this approach gives you a central deployment pipeline which could easily be extended to include code reviews, builds or tests.

## Info

index.js is a Lambda function to be used as a custom action in CodePipeline for deploying from CodeCommit to an S3 Bucket:

 CodePipeline -> Lambda -> S3 Static Website

## Instructions

1. Clone this repo

  `git clone https://github.com/rizavico/StaticS3Deploy.git`

2. cd to the cloned repo:

  `cd StaticS3Deploy`

2. Run npm install to install the dependencies ('mkdirp' and 'yaunzl') for the Lambda function. 

  `npm install`

3. zip up the required files for the Lambda function:

  `zip -r StaticS3SiteDeploy.zip index.js node_modules/`

4. Upload the Lambda function zip archive to AWS Lambda Service using AWS Console.

5. In your CodePipeline, add a new action that invokes this Lambda function. You should specific the following as UserParameters:

`{ "artifact":"MyApp", "s3StaticSiteBucket":"your-S3-destination-bucket-name", "s3StaticSiteBucketRegion":"Your S3 Region e.g. us-east-1", "sourceDirectory": "Directory in your artifacts that you want to publish to S3 e.g. public/assets"}`

## Caveats

The output artifact from CodeCommit is a zip archive which is extracted to /tmp in the Lambda function. Lambda limits us to 512 MB in /tmp, so this function will not work if your codebase is larger than this. The function could easily be modified to extract individual files, upload, then delete, rather than extracting all in one go.
It would be ideal if CodePipeline gave us the output artifact as a tarball, so that it could all be handled via a stream in memory.
