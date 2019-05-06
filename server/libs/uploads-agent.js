'use strict'

/* global db, git, lang, upl */

const path = require('path')
const Promise = require('bluebird')
const fs = Promise.promisifyAll(require('fs-extra'))
const readChunk = require('read-chunk')
const fileType = require('file-type')
const mime = require('mime-types')
const crypto = require('crypto')
const chokidar = require('chokidar')
const jimp = require('jimp')
const imageSize = Promise.promisify(require('image-size'))
const _ = require('lodash')

const winston = global.winston // local ref
/**
 * Uploads - Agent
 */
module.exports = {

  _uploadsPath: './repo/uploads',
  _uploadsThumbsPath: './data/thumbs',

  _watcher: null,

  /**
   * Initialize Uploads model
   *
   * @return     {Object}  Uploads model instance
   */
  init () {
    let self = this

    self._uploadsPath = path.resolve(ROOTPATH, appconfig.paths.repo, 'uploads')
    self._uploadsThumbsPath = path.resolve(ROOTPATH, appconfig.paths.data, 'thumbs')

    return self
  },

  /**
   * Watch the uploads folder for changes
   *
   * @return     {Void}  Void
   */
  watch () {
    let self = this

    self._watcher = chokidar.watch(self._uploadsPath, {
      persistent: true,
      ignoreInitial: true,
      cwd: self._uploadsPath,
      depth: 1,
      awaitWriteFinish: true
    })

    // -> Add new upload file

    self._watcher.on('add', (p) => {
      let pInfo = self.parseUploadsRelPath(p)
      return self.processFile(pInfo.folder, pInfo.filename).then((mData) => {
        return db.UplFile.findByIdAndUpdate(mData._id, mData, { upsert: true })
      }).then(() => {
        return git.commitUploads(lang.t('git:uploaded', { path: p }))
      })
    })

    // -> Remove upload file

    self._watcher.on('unlink', (p) => {
      return git.commitUploads(lang.t('git:deleted', { path: p }))
    })
  },

  /**
   * Initial Uploads scan
   *
   * @return     {Promise<Void>}  Promise of the scan operation
   */
  async initialScan () {
    let self = this

    winston.info('Reading uploads directory.')
    const ls = await fs.readdirAsync(self._uploadsPath)
    try {
      // Get all folders
      winston.info(`${ls.length} files/folders found.`)
      const arrDirs = await Promise.map(ls, async (f) => {
        const s = await fs.statAsync(path.join(self._uploadsPath, f))
        return { filename: f, stat: s }
      }).filter((s) => { return s.stat.isDirectory() })
      winston.info(`Found ${arrDirs.length} directories.`)
      let folderNames = _.map(arrDirs, 'filename')
      folderNames.unshift('')

      // Add folders to DB
      winston.info('Removing old uploaded folders')
      await db.UplFolder.remove({})
      winston.info(`Inserting ${folderNames.length} folders into database.`)
      await db.UplFolder.insertMany(_.map(folderNames, (f) => {
        return {
          _id: 'f:' + f,
          name: f
        }
      }))
      let allFiles = []
      winston.info('Traversing directories')
      try {
        await Promise.map(folderNames, async (fldName) => {
          winston.info(`Traversing directory: ${fldName}`)
          let fldPath = path.join(self._uploadsPath, fldName)
          const fList = await fs.readdirAsync(fldPath)
          winston.info(`${fldName} - ${fList.length} files found.`)
          await Promise.map(fList, async (f) => {
            const mData = await upl.processFile(fldName, f)
            if (mData) {
              winston.info(`Adding "${f}" to list of files.`)
              allFiles.push(mData)
            } else {
              winston.error(`Skipping file "${f}"`)
            }
          })
        })
      } catch (err) {
        winston.error('Error during initial scan:', err)
      } finally {
        // Add files to DB
        winston.info('Removing old uploaded files')
        await db.UplFile.remove({})
        if (_.isArray(allFiles) && allFiles.length > 0) {
          winston.info(`Inserting ${allFiles.length} files into database.`)
          await db.UplFile.insertMany(allFiles)
        } else {
          winston.info('No files to insert, skipping.')
        }
      }
      // Watch for new changes
      winston.info('Setting watcher for uploads folder.')
      return upl.watch()
    } catch (err) {
      return winston.error('Failed during initial scan of uploads: ', err)
    }
  },

  /**
   * Parse relative Uploads path
   *
   * @param      {String}  f       Relative Uploads path
   * @return     {Object}  Parsed path (folder and filename)
   */
  parseUploadsRelPath (f) {
    let fObj = path.parse(f)
    return {
      folder: fObj.dir,
      filename: fObj.base
    }
  },

  /**
   * Get metadata from file and generate thumbnails if necessary
   *
   * @param      {String}  fldName  The folder name
   * @param      {String}  f        The filename
   * @return     {Promise<Object>}  Promise of the file metadata
   */
  async processFile (fldName, f) {
    winston.info(`${fldName} - processing file: ${f}`)
    let self = this

    try {
      let fldPath = path.join(self._uploadsPath, fldName)
      let fPath = path.join(fldPath, f)
      let fPathObj = path.parse(fPath)
      let fUid = crypto.createHash('md5').update(fldName + '/' + f).digest('hex')
      const s = await fs.statAsync(fPath)
      if (!s.isFile()) {
        winston.info(`"${fPath}" was not a valid file!`)
        return false
      }

      // Get MIME info

      let mimeInfo = fileType(readChunk.sync(fPath, 0, 262))
      if (_.isNil(mimeInfo)) {
        mimeInfo = {
          mime: mime.lookup(fPathObj.ext) || 'application/octet-stream'
        }
      }

      // Images

      if (s.size < 3145728) { // ignore files larger than 3MB
        if (_.includes(['image/png', 'image/jpeg', 'image/gif', 'image/bmp'], mimeInfo.mime)) {
          const mImgSize = await self.getImageSize(fPath)
          let cacheThumbnailPath = path.parse(path.join(self._uploadsThumbsPath, fUid + '.png'))
          let cacheThumbnailPathStr = path.format(cacheThumbnailPath)

          let mData = {
            _id: fUid,
            category: 'image',
            mime: mimeInfo.mime,
            extra: mImgSize,
            folder: 'f:' + fldName,
            filename: f,
            basename: fPathObj.name,
            filesize: s.size
          }

          // Generate thumbnail
          winston.info(`${fldName} - generating thumbnail: ${f}`)
          let thumbExists
          try {
            const st = await fs.statAsync(cacheThumbnailPathStr)
            thumbExists = st.isFile()
          } catch (err) {
            thumbExists = false
          }
          if (thumbExists) {
            return mData
          } else {
            await fs.ensureDirAsync(cacheThumbnailPath.dir)
            await self.generateThumbnail(fPath, cacheThumbnailPathStr)
            return mData
          }
        }
      } else {
        winston.info(`${fldName} - file too large to save to uploads: ${f}`)
      }

      // Other Files

      return {
        _id: fUid,
        category: 'binary',
        mime: mimeInfo.mime,
        folder: 'f:' + fldName,
        filename: f,
        basename: fPathObj.name,
        filesize: s.size
      }
    } catch (err) {
      return winston.error('Error processing file:', err)
    }
  },

  /**
   * Generate thumbnail of image
   *
   * @param      {String}           sourcePath  The source path
   * @param      {String}           destPath    The destination path
   * @return     {Promise<Object>}  Promise returning the resized image info
   */
  async generateThumbnail (sourcePath, destPath) {
    try {
      const img = await jimp.read(sourcePath)
      await new Promise((resolve, reject) => {
        img
          .contain(150, 150)
          .rgba(false)
          .write(destPath, (err, img) => {
            if (err) return reject(err)
            return resolve(img)
          })
      })
    } catch (err) {
      winston.error('Unable to generate thumbnail:', err)
      throw err
    }
  },

  /**
   * Gets the image dimensions.
   *
   * @param      {String}  sourcePath  The source path
   * @return     {Object}  The image dimensions.
   */
  getImageSize (sourcePath) {
    return imageSize(sourcePath)
  }

}
