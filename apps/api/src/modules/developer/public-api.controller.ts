/**
 * The organization API, v1. Same host, same /api/v1 prefix, no workspace in
 * the path: the key says which workspace and project a call is for.
 *
 *   GET  /api/v1/capabilities            what can be made, prices, params
 *   GET  /api/v1/balance
 *   POST /api/v1/uploads/from-url        we fetch it
 *   POST /api/v1/uploads                 a presigned PUT for large files
 *   POST /api/v1/uploads/:id/complete
 *   POST /api/v1/generations             { capability, params, clientKey?, merchantRef? }
 *   GET  /api/v1/generations             this key's project, newest first
 *   GET  /api/v1/generations/:id
 *   POST /api/v1/generations/:id/cancel
 *   POST /api/v1/generations/:id/unlock  the rest of a song
 *   GET  /api/v1/catalogue/audio/genres | voices | dub-languages
 *
 * The audio catalogues sit under /catalogue because /audio/* is the STUDIO's,
 * declared by AudioController for a session. Both controllers had claimed
 * those three paths and AudioModule registers first, so an API key reaching
 * /audio/genres met the session guard and was refused — these handlers had
 * never once run. See routes.spec.ts, which now refuses a duplicate path.
 *
 * Every answer is the same envelope the portal gets; every error has a
 * `error` identifier and may include a `fields` array. See docs/API.md.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { AudioService } from '../audio/audio.service';
import { ProviderRegistry } from '../provider/provider.registry';
import { PresignUploadDto } from '../media/media.dto';
import { ApiKeyGuard, RequireScope } from './api-key.guard';
import { PublicApiService } from './public-api.service';
import { ApiCreateGenerationDto, ApiListGenerationsDto, ApiQuoteGenerationDto, ApiUploadUrlDto } from './public-api.dto';

@ApiTags('public api')
@ApiBearerAuth('apiKey')
@Public()
@UseGuards(ApiKeyGuard)
@Controller({ version: '1' })
export class PublicApiController {
  constructor(
    private readonly api: PublicApiService,
    private readonly audio: AudioService,
    private readonly registry: ProviderRegistry,
  ) {}

  @Get('/capabilities')
  @RequireScope('catalogue:read')
  @ApiOperation({ summary: 'What can be made, what each costs, and the parameters it takes' })
  capabilities() {
    return this.api.capabilities();
  }

  @Get('/balance')
  @RequireScope('balance:read')
  @ApiOperation({ summary: 'Credits left in the workspace' })
  balance(@Req() req: Request) {
    return this.api.balance(req.apiKey!);
  }

  @Post('/uploads/from-url')
  @RequireScope('media:write')
  @ApiOperation({ summary: 'Fetch a public URL into the workspace as a source file' })
  fromUrl(@Req() req: Request, @Body() body: ApiUploadUrlDto) {
    return this.api.uploadFromUrl(req.apiKey!, body.url);
  }

  @Post('/uploads')
  @RequireScope('media:write')
  @ApiOperation({ summary: 'A presigned PUT for a file you hold; call complete afterwards' })
  presign(@Req() req: Request, @Body() body: PresignUploadDto) {
    return this.api.presign(req.apiKey!, body);
  }

  @Post('/uploads/:uploadId/complete')
  @RequireScope('media:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The PUT finished; verify and make the file usable' })
  complete(@Req() req: Request, @Param('uploadId', ParseUUIDPipe) uploadId: string) {
    return this.api.complete(req.apiKey!, uploadId);
  }

  @Post('/generations')
  @RequireScope('generations:write')
  @ApiOperation({ summary: 'Ask for a generation; poll it or receive a webhook when it finishes' })
  create(@Req() req: Request, @Body() body: ApiCreateGenerationDto) {
    return this.api.create(req.apiKey!, body);
  }

  @Post('/generations/quote')
  @RequireScope('catalogue:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate complete parameters and estimate credits without creating a generation or reserving credits' })
  quote(@Req() req: Request, @Body() body: ApiQuoteGenerationDto) {
    return this.api.quote(req.apiKey!, body);
  }

  @Get('/generations')
  @RequireScope('generations:read')
  @ApiOperation({ summary: "This project's generations, newest first" })
  list(@Req() req: Request, @Query() q: ApiListGenerationsDto) {
    return this.api.list(req.apiKey!, q);
  }

  @Get('/generations/:generationId')
  @RequireScope('generations:read')
  @ApiOperation({ summary: 'One generation with signed output URLs' })
  get(@Req() req: Request, @Param('generationId', ParseUUIDPipe) id: string) {
    return this.api.get(req.apiKey!, id);
  }

  @Post('/generations/:generationId/cancel')
  @RequireScope('generations:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a generation that has not started' })
  cancel(@Req() req: Request, @Param('generationId', ParseUUIDPipe) id: string) {
    return this.api.cancel(req.apiKey!, id);
  }

  @Post('/generations/:generationId/unlock')
  @RequireScope('generations:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pay for the rest of a song' })
  async unlock(@Req() req: Request, @Param('generationId', ParseUUIDPipe) id: string) {
    await this.api.own(req.apiKey!, id);
    return this.audio.unlock(req.actor!, req.apiKey!.workspaceId, id, req);
  }

  @Get('/catalogue/audio/genres')
  @RequireScope('catalogue:read')
  @ApiOperation({ summary: 'Music genres' })
  genres() {
    return this.audio.genres();
  }

  @Get('/catalogue/audio/voices')
  @RequireScope('catalogue:read')
  @ApiOperation({ summary: 'Voices this environment can serve' })
  voices() {
    return this.audio.voices((k) => this.registry.get(k) !== undefined);
  }

  @Get('/catalogue/audio/unlock-price')
  @RequireScope('catalogue:read')
  @ApiOperation({ summary: 'Current additional credit price to unlock a full song' })
  unlockPrice() {
    return this.audio.unlockPrice();
  }

  @Get('/catalogue/audio/dub-languages')
  @RequireScope('catalogue:read')
  @ApiOperation({ summary: 'Languages a video can be dubbed into' })
  dubLanguages() {
    return this.audio.dubLanguages((k) => this.registry.get(k) !== undefined);
  }
}
