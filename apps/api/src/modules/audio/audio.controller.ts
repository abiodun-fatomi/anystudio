import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { VOICE_SAMPLE } from '@anystudio/shared';
import { AudioService, CLONES_PER_WORKSPACE } from './audio.service';
import { CloneVoiceDto } from './audio.dto';
import { ProviderRegistry } from '../provider/provider.registry';
import { CurrentActor, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('audio')
@ApiCookieAuth('session')
@Controller({ version: '1' })
export class AudioController {
  constructor(
    private readonly audio: AudioService,
    private readonly registry: ProviderRegistry,
  ) {}

  @Get('/audio/genres')
  @ApiOperation({ summary: 'The music genre catalogue' })
  genres() {
    return this.audio.genres();
  }

  @Get('/audio/voices')
  @ApiOperation({ summary: 'Voices for voiceovers — only those a configured vendor can serve' })
  voices() {
    return this.audio.voices((k) => this.registry.get(k) !== undefined);
  }

  @Get('/audio/dub-languages')
  @ApiOperation({ summary: 'Languages a video can be dubbed into here — only those a configured vendor speaks' })
  dubLanguages() {
    return this.audio.dubLanguages((k) => this.registry.get(k) !== undefined);
  }

  @Get('/workspaces/:workspaceId/voices')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Voices this workspace can use: the catalogue plus its own cloned voices' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  async workspaceVoices(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    const voices = await this.audio.voicesFor(workspaceId, (k) => this.registry.get(k) !== undefined);
    return { voices, cloning: { available: this.audio.cloningAvailable(), limit: CLONES_PER_WORKSPACE, sample: VOICE_SAMPLE } };
  }

  @Post('/workspaces/:workspaceId/voices')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Clone your own voice from a recording you consent to' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  cloneVoice(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: CloneVoiceDto, @Req() req: Request) {
    return this.audio.cloneVoice(actor, workspaceId, dto, req);
  }

  @Delete('/workspaces/:workspaceId/voices/:key')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Forget one of your own voices, here and at the vendor' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  deleteVoice(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('key') key: string, @Req() req: Request) {
    return this.audio.deleteVoice(actor, workspaceId, key, req);
  }

  @Get('/audio/unlock-price')
  @ApiOperation({ summary: 'What unlocking a full song costs' })
  unlockPrice() {
    return this.audio.unlockPrice();
  }

  @Post('/workspaces/:workspaceId/generations/:generationId/unlock')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pay for the rest of a song; the full track becomes downloadable' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  unlock(
    @CurrentActor() actor: Actor,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('generationId', ParseUUIDPipe) generationId: string,
    @Req() req: Request,
  ) {
    return this.audio.unlock(actor, workspaceId, generationId, req);
  }
}
