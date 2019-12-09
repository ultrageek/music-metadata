import * as Stream from 'stream';
import * as strtok3 from 'strtok3';

import * as Core from './core';
import { ParserFactory } from './ParserFactory';
import { IAudioMetadata, IOptions } from './type';
import * as _debug from 'debug';
import { RandomFileReader } from './common/RandomFileReader';

export { IAudioMetadata, IOptions, ITag, INativeTagDict, ICommonTagsResult, IFormat, IPicture, IRatio, IChapter } from './type';

const debug = _debug("music-metadata:parser");

export { parseFromTokenizer } from './core';

/**
 * Parse audio from Node Stream.Readable
 * @param stream - Stream to read the audio track from
 * @param mimeType - Content specification MIME-type, e.g.: 'audio/mpeg'
 * @param options - Parsing options
 * @returns Metadata
 */
export async function parseStream(stream: Stream.Readable, mimeType?: string, options: IOptions = {}): Promise<IAudioMetadata> {
  const tokenizer = await strtok3.fromStream(stream);
  return Core.parseFromTokenizer(tokenizer, mimeType, options);
}

/**
 * Parse audio from Node Buffer
 * @param stream - Audio input stream
 * @param mimeType - Content specification MIME-type, e.g.: 'audio/mpeg'
 * @param options - Parsing options
 * @returns Metadata
 * Ref: https://github.com/Borewit/strtok3/blob/e6938c81ff685074d5eb3064a11c0b03ca934c1d/src/index.ts#L15
 */
export const parseBuffer = Core.parseBuffer;

/**
 * Parse audio from Node file
 * @param filePath - Media file to read meta-data from
 * @param options - Parsing options
 * @returns Metadata
 */
export async function parseFile(filePath: string, options: IOptions = {}): Promise<IAudioMetadata> {

  debug(`parseFile: ${filePath}`);

  const fileTokenizer = await strtok3.fromFile(filePath);

  const fileReader = new RandomFileReader(filePath, fileTokenizer.fileSize);
  try {
    await Core.scanAppendingHeaders(fileReader, options);
  } finally {
    fileReader.close();
  }

  try {
    const parserName = ParserFactory.getParserIdForExtension(filePath);
    if (!parserName)
      debug(' Parser could not be determined by file extension');

    return await ParserFactory.parse(fileTokenizer, parserName, options);
  } finally {
    await fileTokenizer.close();
  }
}

/**
 * Create a dictionary ordered by their tag id (key)
 * @param nativeTags - List of tags
 * @returns Tags indexed by id
 */
export const orderTags = Core.orderTags;

/**
 * Convert rating to 1-5 star rating
 * @param rating - Normalized rating [0..1] (common.rating[n].rating)
 * @returns Number of stars: 1, 2, 3, 4 or 5 stars
 */
export const ratingToStars = Core.ratingToStars;
