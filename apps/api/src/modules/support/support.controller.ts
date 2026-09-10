/**
 * Help & support, as the person sees it: one open chat, the assistant
 * answering, closing mails the transcript.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentActor } from '../auth/decorators';
import type { Actor } from '../auth/policy';
import { SupportService } from './support.service';
import { CloseConversationDto, OpenConversationDto, SupportMessageDto } from './support.dto';

@ApiTags('support')
@ApiCookieAuth('session')
@Controller({ path: 'support/conversations', version: '1' })
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('/current')
  @ApiOperation({ summary: 'The open chat, or null' })
  current(@CurrentActor() a: Actor) {
    return this.support.current(a);
  }

  @Get('/history')
  @ApiOperation({ summary: 'Closed chats, newest first' })
  history(@CurrentActor() a: Actor) {
    return this.support.history(a);
  }

  @Post()
  @ApiOperation({ summary: 'Open a chat (or return the one already open)' })
  open(@CurrentActor() a: Actor, @Body() b: OpenConversationDto, @Req() req: Request) {
    return this.support.open(a, b, req);
  }

  @Get('/:id')
  one(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.one(a, id);
  }

  @Post('/:id/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Say something; the assistant answers in the same response' })
  send(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() b: SupportMessageDto, @Req() req: Request) {
    return this.support.send(a, id, b, req);
  }

  @Post('/:id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the chat; a transcript is emailed' })
  close(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() b: CloseConversationDto) {
    return this.support.close(a, id, b);
  }
}
