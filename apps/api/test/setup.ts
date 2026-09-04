import 'reflect-metadata';
// A valid 32-byte key so anything that encrypts can run; never a real one.
process.env.APP_KEY ??= Buffer.alloc(32, 7).toString('base64');
