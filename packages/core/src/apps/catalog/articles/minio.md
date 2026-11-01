## Object storage for your applications

MinIO provides an S3-compatible API for application uploads, media, exports, and other files that belong outside your relational database.

The template runs MinIO with persistent storage and a web console. Install settings configure the bucket, while generated credentials and connection details help you connect an application.

## Connect an S3 client

Use the endpoint and credentials from the connection card with your SDK or command-line client. Your client may need path-style addressing. The API endpoint and browser console use separate ports.

A persistent volume keeps files across container recreation; configure backups for important objects. The [community source repository](https://github.com/minio/minio) is archived. The template's actual image is listed below.
