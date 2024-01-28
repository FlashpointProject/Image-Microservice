import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import sharp from 'sharp';
import * as fs from 'fs';
import prettyBytes from 'pretty-bytes';
import e from 'express';

dotenv.config();

const app: Express = express();
const port = process.env.PORT;
const urlBase = process.env.URL_BASE || '';
const imagesFolder = path.resolve(process.env.IMAGES_FOLDER || 'images');
const cacheFolder = path.resolve(process.env.CACHE_FOLDER || 'cache');
const debug = !!process.env.DEBUG;
const apiKey = process.env.API_KEY;

function debugPrint(text: string) {
  if (debug) {
    console.log(text);
  };
}

async function dirSize(folder: string): Promise<number> {
  let bytes = 0;
  const files = await fs.promises.readdir(folder, { withFileTypes: true });
  for (const f of files) {
    if (f.isDirectory()) {
      bytes += await dirSize(path.join(folder, f.name));
    } else {
      bytes += (await fs.promises.stat(path.join(folder, f.name))).size;
    }
  }
  return bytes;
}

async function precacheTask(folders: string[]) {
  console.log('Started precache task for ' + folders.join('/'));
  const startTime = new Date();
  const cachePath = path.join(cacheFolder, ...folders);
  const rootPath = path.join(imagesFolder, ...folders);
  await fs.promises.mkdir(cachePath, { recursive: true });
  await fs.promises.mkdir(cachePath, { recursive: true });
  const badPaths = await precacheFolder(cachePath, rootPath, rootPath);
  const msTaken = (new Date()).getTime() - startTime.getTime();
  console.log(`Precache finished for ${folders.join('/')}, took ${Math.floor(msTaken/1000)} seconds`);
  if (badPaths.length > 0) {
    const logPath = folders.join('-') + '.txt';
    await fs.promises.writeFile(logPath, badPaths.join('\n'));
    console.log(`${badPaths.length} Precache failures for ${folders.join('/')} saved to ${logPath}`)
  }
  if (debug) {
    // Calculate original size
    const orgSize = await dirSize(rootPath);
    // Calculate cache size
    const size = await dirSize(cachePath);
    console.log(`Precache size for ${folders.join('/')}` +
    `\nFailures - ${badPaths.length}` +
    `\nOriginal - ${prettyBytes(orgSize)}` +
    `\nCached   - ${prettyBytes(size)}` +
    `\nSaved    - ${prettyBytes(orgSize - size)} (${((size / orgSize) * 100).toFixed(2)}%)`);
  }
}

async function precacheFolder(cachePath: string, rootPath: string, folder: string): Promise<string[]> {
  let badPaths: string[] = [];
  const files = await fs.promises.readdir(folder, { withFileTypes: true });
  for (const file of files) {
    if (file.isDirectory()) {
      // Cache folder
      const newFolder = path.join(folder, file.name);
      await precacheFolder(cachePath, rootPath, newFolder)
      .then((res) => {
        badPaths = badPaths.concat(res);
      });
    } else {
      // Cache file
      const filePath = path.join(folder, file.name);
      const relPath = path.relative(rootPath, filePath);
      await getOrCreateCacheFile(cachePath, filePath, relPath, { type: 'jpg' })
      .catch(() => {
        badPaths.push(filePath);
      });
    }
  }
  return badPaths;
}

type CacheFile = {
  success: boolean;
  filePath: string;
}

async function getOrCreateCacheFile(cachePath: string, filePath: string, relPath: string, opts: ImageOpts): Promise<CacheFile> {
  // Swap extension for one in opts for savings
  const newFileName = path.parse(path.basename(relPath)).name + '.' + opts.type;
  const newRelPath = path.join(path.dirname(relPath), newFileName);
  const destPath = path.join(cachePath, newRelPath);

  // If a PNG, just serve the original
  if (opts.type === 'png') {
    return {
      success: true,
      filePath
    };
  }

  // Not a PNG, commence caching
  return fs.promises.access(destPath, fs.constants.R_OK)
  .then(() => {
    return {
      success: true,
      filePath: destPath
    };
  })
  .catch(async () => {
    // Check source exists before caching
    const exists = await fs.promises.access(filePath, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);
    if (!exists) {
      return {
        success: false,
        filePath: ''
      }
    }
    // Cache missing, create now
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    return new Promise<CacheFile>((resolve, reject) => {
      sharp(filePath)
      .toFormat(opts.type)
      .toBuffer((err, buffer, info) => {
        if (err) {
          reject(err);
        } else {
          fs.writeFile(destPath, buffer, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve({
                success: true,
                filePath: destPath
              });
            }
          });
        }
      });
    });
  });
}

function genImageRoute(folders: string[]) {
  const cachePath = path.join(cacheFolder, ...folders);
  const rootPath = path.join(imagesFolder, ...folders);
  fs.mkdirSync(cachePath, { recursive: true });

  app.get(`/${urlBase}/${folders.join('/')}/:f1/:f2/:filename`, async (req: Request, res: Response) => {
    const filePath = path.join(rootPath, req.params.f1, req.params.f2, req.params.filename);
    const relPath = path.relative(rootPath, filePath);
    if (isSubFile(imagesFolder, filePath)) {
      // Check query params for options
      const opts = parseOptionQuery(req.query);

      await getOrCreateCacheFile(cachePath, filePath, relPath, opts)
      .then((cacheFileInfo) => {
        if (cacheFileInfo.success) {
          res.sendFile(cacheFileInfo.filePath);
        } else {
          res.status(404).send('Not Found');
        }
      })
      .catch((err) => {
        res.status(500).send('Error processing image');
        console.error(err);
      });

    }
  });

  app.delete(`/${urlBase}/${folders.join('/')}/:f1/:f2/:filename`, async (req, res) => {
    // Check the Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
      return res.status(401).send('Unauthorized');
    }
  
    // If authorized, proceed to delete the file
    const filePath = path.join(rootPath, req.params.f1, req.params.f2, req.params.filename);
    const relPath = path.relative(rootPath, filePath);
    const newFileName = path.parse(path.basename(relPath)).name + '.jpg';
    const newRelPath = path.join(path.dirname(relPath), newFileName);
    const destPath = path.join(cachePath, newRelPath);
    console.log("Deleting " + destPath);

    if (isSubFile(cachePath, destPath)) {
      // Add your logic to check if the file exists and delete it
      try {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        res.status(200).send('File deleted successfully');
      } catch (err) {
        console.error(err);
        res.status(500).send('Error deleting file');
      }
    } else {
      res.status(400).send('File in bad directory');
    }
  });
}

genImageRoute(['Logos']);
genImageRoute(['Screenshots']);

app.get(`/${urlBase}/`, (req: Request, res: Response) => {
  res.send('Express + TypeScript Server');
});

// Start precache task
precacheTask(['Logos']);
precacheTask(['Screenshots']);

app.listen(Number(port), "0.0.0.0", () => {
  console.log(`⚡️[server]: Server is running at http://0.0.0.0:${port}`);
});

function isSubFile(root: string, absPath: string) {
  const relPath = path.relative(root, absPath);
  return relPath && !relPath.startsWith('..') && !path.isAbsolute(relPath);
}

type ImageOpts = {
  type: typeof validTypes[number]
}

const validTypes = ['png', 'jpg'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOptionQuery(query: any) {
  const opts: ImageOpts = {
    type: 'png'
  };

  if (query.type) {
    if (!validTypes.includes(query.type)) { throw 'Invalid image type'; }
    opts.type = query.type;
  }

  return opts;
}
