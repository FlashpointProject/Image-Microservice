import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import sharp from 'sharp';
import * as fs from 'fs';

dotenv.config();

const app: Express = express();
const port = process.env.PORT;
const urlBase = process.env.URL_BASE || '';
const imagesFolder = path.resolve(process.env.IMAGES_FOLDER || 'images');
const cacheFolder = path.resolve(process.env.CACHE_FOLDER || 'cache');

async function precacheTask(folders: string[]) {
  const cachePath = path.join(cacheFolder, ...folders);
  const rootPath = path.join(imagesFolder, ...folders);
  await fs.promises.mkdir(cachePath, { recursive: true });
  await fs.promises.mkdir(cachePath, { recursive: true });
  await precacheFolder(cachePath, rootPath, rootPath);
}

async function precacheFolder(cachePath: string, rootPath: string, folder: string) {
  const files = await fs.promises.readdir(folder, { withFileTypes: true });
  for (const file of files) {
    if (file.isDirectory()) {
      // Cache folder
      const newFolder = path.join(folder, file.name);
      await precacheFolder(cachePath, rootPath, newFolder);
    } else {
      // Cache file
      const filePath = path.join(folder, file.name);
      const relPath = path.relative(rootPath, filePath);
      await getOrCreateCacheFile(cachePath, filePath, relPath, { type: 'jpg' });
    }
  }
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

  app.get(`${urlBase}/${folders.join('/')}/:f1/:f2/:filename`, async (req: Request, res: Response) => {
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
      .catch(() => {
        res.status(500).send('Error processing image');
      });

    }
  });
}

genImageRoute(['Logos']);
genImageRoute(['Screenshots']);

app.get(`${urlBase}/`, (req: Request, res: Response) => {
  res.send('Express + TypeScript Server');
});

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
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