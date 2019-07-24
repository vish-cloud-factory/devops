'use strict';

// CodePipeline should have the following "UserParameters":
//  'artifact' : name of output artifact from the CodeCommit source stage.
//  's3StaticSiteBucket' : name of desination bucket for the S3 static website.
//  's3StaticSiteBucketRegion' : region of the S3 bucket.
//  'sourceDirectory' : directory in your artifact that will be published to S3 (note: no trailing slash)

const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const unzip = require('yauzl');
const mkdirp = require('mkdirp');
const mime = require('mime');

const filePath = '/tmp/artifact.zip';
const cwd = '/tmp';
const codepipeline = new AWS.CodePipeline();

exports.handler = (event, context) => {
  const jobData = event['CodePipeline.job'].data;
  const jobId = event['CodePipeline.job'].id;

  function signalLambda(err) {
    if (err) {
      // Although failed, signal context.succeed to avoid Lambda function being retried.
      context.succeed('Failed - see cloudwatch logs for more details.');
    } else {
      context.succeed('Done');
    }
  }

  function putJobSuccess() {
    console.log('Sending success!');
    return codepipeline.putJobSuccessResult({ jobId }).promise()
      .then(() => signalLambda(null));
  }

  function putJobFailure(message) {
    console.error('Error occurred, sending failure.');
    console.error(message);
    const params = {
      jobId: jobId,
      failureDetails: {
        message: JSON.stringify(message),
        type: 'JobFailed',
        externalExecutionId: context.invokeid,
      },
    };
    return codepipeline.putJobFailureResult(params).promise()
      .then(() => signalLambda('Error'));
  }

  function getUserParams() {
    try {
      const inputJson = JSON.parse(jobData.actionConfiguration.configuration.UserParameters);
      return {
        artifactName: inputJson.artifact,
        s3StaticSiteBucket: inputJson.s3StaticSiteBucket,
        s3StaticSiteBucketRegion: inputJson.s3StaticSiteBucketRegion,
        sourceDirectory: inputJson.sourceDirectory
      };
    } catch (err) {
      putJobFailure(err);
      signalLambda(err);
    }
  }

  function getS3BucketLocation(artifactName) {
    const arr = jobData.inputArtifacts;
    for (const obj of arr) {
      if (obj.name === artifactName) {
        return {
          bucket: obj.location.s3Location.bucketName,
          key: obj.location.s3Location.objectKey,
        };
      }
      putJobFailure('Unable to get Source S3 Bucket info from JSON');
    }
  }

  function createDownloadS3Client(sourceS3Bucket) {
    const keyId = jobData.artifactCredentials.accessKeyId;
    const keySecret = jobData.artifactCredentials.secretAccessKey;
    const sessionToken = jobData.artifactCredentials.sessionToken;

    return new AWS.S3({
      accessKeyId: keyId,
      secretAccessKey: keySecret,
      sessionToken: sessionToken,
      params: { Bucket: sourceS3Bucket },
      signatureVersion: 'v4',
    });
  }

  function getCodeFromS3(s3client, key) {
    return new Promise((resolve, reject) => {
      console.log('Downloading CodePipeline artifact.');
      const writeStream = fs.createWriteStream(filePath);
      const req = s3client.getObject({ Key: key });
      req.on('error', reject);
      const readStream = req.createReadStream();
      readStream.on('error', reject);
      readStream.pipe(writeStream);
      writeStream.on('error', reject);
      writeStream.once('finish', () => {
        resolve();
      });
    });
  }

  function unzipCode() {
    console.log('Unzipping contents...');
    return new Promise((resolve, reject) => {
      const files = [];
      unzip.open(filePath, { autoclose: false, lazyEntries: true }, (err, zipfile) => {
        if (err) reject;
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if(!sourceDirectoryRegEx.test(entry.fileName)){
              console.log("  [X] Skipping: "+entry.fileName);
              zipfile.readEntry();
          }else{
            console.log("  [+] Unzipping: "+entry.fileName);
            if (/\/$/.test(entry.fileName)) {
              // directory file names end with '/'
              mkdirp(path.join(cwd, entry.fileName), (err) => {
                if (err) reject;
                zipfile.readEntry();
              });
            } else {
              zipfile.openReadStream(entry, (err, readStream) => {
                if (err) reject;
                // ensure parent directory exists
                mkdirp(path.join(cwd, path.dirname(entry.fileName)), (err) => {
                  if (err) reject;
                  readStream.pipe(fs.createWriteStream(path.join(cwd, entry.fileName)));
                  readStream.on('end', () => {
                    // add file details to files array
                    files.push({
                      key: entry.fileName,
                      body: fs.createReadStream(path.join(cwd, entry.fileName)),
                    });
                    zipfile.readEntry();
                  });
                });
              });
            }
          }
        });
        zipfile.once('end', () => {
          zipfile.close();
          resolve(files);
        });
      });
    });
  }

  function putObjects(files, s3UploadClient) {
    console.log('Uploading files to S3 Static Website.');
    return Promise.all(files.map((file) => {
      const params = {
        Key: file.key,
        Body: file.body,
        ContentType: mime.lookup(file.key)
      };
      console.log(" > Uploading: "+file.key+" with mime "+mime.lookup(file.key));
      return s3UploadClient.putObject(params).promise();
    }));
  }

  const userParams = getUserParams();
  const sourceDirectoryRegEx = userParams.sourceDirectory != null && userParams.sourceDirectory.length >= 1 ? new RegExp("^"+userParams.sourceDirectory+"/") : new RegExp(".*");
  const sourceBucket = getS3BucketLocation(userParams.artifactName);
  const destBucket = {
    bucket: userParams.s3StaticSiteBucket,
    region: userParams.s3StaticSiteBucketRegion
  };

  const s3DownloadClient = createDownloadS3Client(sourceBucket.bucket);
  const s3UploadClient = new AWS.S3({
    params: { Bucket: destBucket.bucket },
    region: destBucket.region
  });

  getCodeFromS3(s3DownloadClient, sourceBucket.key)
    .then(unzipCode)
    .then((filelist) => {
      return Promise.all([filelist, putObjects(filelist, s3UploadClient)]);
    })
    .then(putJobSuccess)
    .catch((err) => {
      putJobFailure(err);
    });
};
