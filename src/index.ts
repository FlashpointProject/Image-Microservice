import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import sharp from 'sharp';
import * as fs from 'fs';

dotenv.config();

const app: Express = express();
const port = process.env.PORT;
const imagesFolder = path.resolve(process.env.IMAGES_FOLDER || 'images');
const cacheFolder = path.resolve(process.env.CACHE_FOLDER || 'cache');

function genImageRoute(folders: string[]) {
  const cachePath = path.join(cacheFolder, ...folders);
  fs.mkdirSync(cachePath, { recursive: true });
  app.get(`/${folders.join('/')}/:f1/:f2/:filename`, async (req: Request, res: Response) => {
    const filePath = path.join(imagesFolder, ...folders, req.params.f1, req.params.f2, req.params.filename);
    if (isSubFile(imagesFolder, filePath)) {
      const fileName = path.parse(filePath).name;
      // Check query params for options
      const opts = parseOptionQuery(req.query);
      const newFileName = `${fileName}.${opts.type}`;
      // Send original if PNG
      if (opts.type === 'png') {
        await fs.promises.access(filePath, fs.constants.R_OK)
        .then(() => {
          res.sendFile(filePath);
        })
        .catch(() => {
          res.status(404).send('Not Found');
        });
        return;
      }
      // Check if already cached
      const cachedFilePath = path.join(cachePath, newFileName);
      await fs.promises.access(cachedFilePath, fs.constants.R_OK)
      .then(() => {
        res.sendFile(cachedFilePath);
      })
      .catch(async () => {
        // Make sure source exists
        await fs.promises.access(filePath, fs.constants.R_OK)
        .then(async () => {
          const s = sharp(filePath);
          return new Promise<void>((resolve) => {
            s.toFile(cachedFilePath, (err) => {
              if (err) {
                res.status(500).send('Failed processing image');
              } else {
                res.sendFile(cachedFilePath);
              }
              resolve();
            });
          });
        })
        .catch(() => {
          res.status(404).send('Not Found');
        })
      })
    }
  });
}

genImageRoute(['Logos']);
genImageRoute(['Screenshots']);

app.get('/', (req: Request, res: Response) => {
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

const validTypes = ['png', 'jpeg', 'jpg'] as const;

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