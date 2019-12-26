import * as Token from 'token-types';
import * as _debug from 'debug';
import * as assert from 'assert';
import { INativeMetadataCollector } from '../common/MetadataCollector';
import { ITokenizer } from 'strtok3/lib/core';
import { IOptions } from '../type';
import { ITokenParser } from '../ParserFactory';
import { BasicParser } from '../common/BasicParser';
import {
  DataType,
  IContainerType,
  IHeader, IMatroskaDoc,
  ITree, TargetType, TrackType
} from './types';
import * as matroskaDtd from './MatroskaDtd';

const debug = _debug('music-metadata:parser:matroska');

/**
 * Extensible Binary Meta Language (EBML) parser
 * https://en.wikipedia.org/wiki/Extensible_Binary_Meta_Language
 * http://matroska.sourceforge.net/technical/specs/rfc/index.html
 *
 * WEBM VP8 AUDIO FILE
 */
export class MatroskaParser extends BasicParser {

  private padding: number = 0;

  private parserMap = new Map<DataType, (e: IHeader) => Promise<any>>();

  constructor() {
    super();
    this.parserMap.set(DataType.uint, e => this.readUint(e));
    this.parserMap.set(DataType.string, e => this.readString(e));
    this.parserMap.set(DataType.binary, e => this.readBuffer(e));
    this.parserMap.set(DataType.uid, async e => await this.readUint(e) === 1);
    this.parserMap.set(DataType.bool, e => this.readBuffer(e));
    this.parserMap.set(DataType.float, e => this.readFloat(e));
  }

  /**
   * Initialize parser with output (metadata), input (tokenizer) & parsing options (options).
   * @param {INativeMetadataCollector} metadata Output
   * @param {ITokenizer} tokenizer Input
   * @param {IOptions} options Parsing options
   */
  public init(metadata: INativeMetadataCollector, tokenizer: ITokenizer, options: IOptions): ITokenParser {
    super.init(metadata, tokenizer, options);
    return this;
  }

  public async parse(): Promise<void> {
    const matroska = await this.parseContainer(matroskaDtd.elements, this.tokenizer.fileSize, []) as any as IMatroskaDoc;

    this.metadata.setFormat('container', `EBML/${matroska.ebml.docType}`);
    if (matroska.segment) {

      const info = matroska.segment.info;
      if (info) {
        const timecodeScale = info.timecodeScale ? info.timecodeScale : 1000000;
        const duration = info.duration * timecodeScale / 1000000000;
        this.metadata.setFormat('duration', duration);
      }

      const audioTracks = matroska.segment.tracks;
      if (audioTracks && audioTracks.entries) {
        const entries = audioTracks.entries.filter(entry => {
          return entry.trackType === TrackType.audio.valueOf();
        });
        assert.equal(entries.length, 1, 'mapping limited to single audio track');
        const audioTrack = entries[0];

        this.metadata.setFormat('codec', audioTrack.codecID.replace('A_', ''));
        this.metadata.setFormat('sampleRate', audioTrack.audio.samplingFrequency);
        this.metadata.setFormat('numberOfChannels', audioTrack.audio.channels);

        if (matroska.segment.tags) {
          matroska.segment.tags.tag.forEach(tag => {
            const target = tag.target;
            const targetType = target.targetTypeValue ? TargetType[target.targetTypeValue] : (target.targetType ? target.targetType : TargetType.album);
            tag.simpleTags.forEach(simpleTag => {
              const value = simpleTag.string ? simpleTag.string : simpleTag.binary;
              this.addTag(`${targetType}:${simpleTag.name}`, value);
            });
          });
        }
      }
    }
  }

  private async parseContainer(container: IContainerType, posDone: number, path: string[]): Promise<ITree> {
    const tree: ITree = {};
    while (this.tokenizer.position < posDone) {
      const element = await this.readElement();
      const type = container[element.id];
      if (type) {
        if (type.container) {
          const res = await this.parseContainer(type.container, this.tokenizer.position + element.len, path.concat([type.name]));
          if (type.multiple) {
            if (!tree[type.name]) {
              tree[type.name] = [];
            }
            (tree[type.name] as ITree[]).push(res);
          } else {
            tree[type.name] = res;
          }
        } else {
          tree[type.name] = await this.parserMap.get(type.value)(element);
        }
      } else {
        switch (element.id) {
          case 0xec: // void
            this.padding += element.len;
            await this.tokenizer.ignore(element.len);
            break;
          default:
            debug(`parseEbml: path=${path.join('/')}, unknown element: id=${element.id.toString(16)}`);
            this.padding += element.len;
            await this.tokenizer.ignore(element.len);
        }
      }
    }
    return tree;
  }

  private async readVintData(): Promise<Buffer> {
    const msb = await this.tokenizer.peekNumber(Token.UINT8);
    let mask = 0x80;
    let ic = 1;

    // Calculate VINT_WIDTH
    while ((msb & mask) === 0) {
      ++ic;
      mask >>= 1;
    }

    const id = Buffer.alloc(ic);
    await this.tokenizer.readBuffer(id);
    return id;
  }

  private async readElement(): Promise<IHeader> {
    const id = await this.readVintData();
    const lenField = await this.readVintData();
    lenField[0] ^= 0x80 >> (lenField.length - 1);
    const nrLen = Math.min(6, lenField.length); // JavaScript can max read 6 bytes integer
    return {
      id: id.readUIntBE(0, id.length),
      len: lenField.readUIntBE(lenField.length - nrLen, nrLen)
    };
  }

  private async readFloat(e: IHeader) {
    switch (e.len) {
      case 0:
        return 0.0;
      case 4:
        return this.tokenizer.readNumber(Token.Float32_BE);
      case 8:
        return this.tokenizer.readNumber(Token.Float64_BE);
      case 10:
        return this.tokenizer.readNumber(Token.Float64_BE);
      default:
        throw new Error(`Invalid IEEE-754 float length: ${e.len}`);
    }
  }

  private async readFlag(e: IHeader): Promise<boolean> {
    return (await this.readUint(e)) === 1;
  }

  private async readUint(e: IHeader): Promise<number> {
    const buf = await this.readBuffer(e);
    const nrLen = Math.min(6, e.len); // JavaScript can max read 6 bytes integer
    return buf.readUIntBE(e.len - nrLen, nrLen);
  }

  private async readString(e: IHeader): Promise<string> {
    return this.tokenizer.readToken(new Token.StringType(e.len, 'utf-8'));
  }

  private async readBuffer(e: IHeader): Promise<Buffer> {
    const buf = Buffer.alloc(e.len);
    await this.tokenizer.readBuffer(buf);
    return buf;
  }

  private addTag(tagId: string, value: any) {
    this.metadata.addTag('matroska', tagId, value);
  }
}
