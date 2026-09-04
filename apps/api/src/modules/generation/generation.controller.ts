/**
 * Generations over HTTP. Thin: every rule lives in the service.
 *
 * The stream endpoint is the one that is not a plain JSON handler. It holds
 * the response open and writes server-sent events until the generation
 * reaches a terminal state or the client goes away — and it is careful to
 * stop watching when the client does, or every closed studio tab would keep
 * a Redis subscription alive.
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { GenerationService } from './generation.service';
import { GenerationEvents } from './generation.events';
import { CreateGenerationDto, GenerationHistoryQueryDto, QuoteQueryDto } from './generation.dto';
import { CurrentActor, RequireWorkspaceRole } from '../auth/decorators';
import type { SessionActor } from '../auth/policy';

@ApiTags('generation')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/generations', version: '1' })
export class GenerationController {
  constructor(
    private readonly generations: GenerationService,
    private readonly events: GenerationEvents,
  ) {}

  @Get('/quote')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'What a generation would cost, and the balance after' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  quote(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() query: QuoteQueryDto) {
    return this.generations.quote(workspaceId, query.capability, query.costCode);
  }

  @Post()
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Request a generation: writes the row, holds the credits, queues the work' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiBody({ type: CreateGenerationDto })
  @ApiResponse({ status: 201, description: 'generation, balance' })
  @ApiResponse({ status: 400, description: 'The params did not fit the capability' })
  @ApiResponse({ status: 402, description: 'Not enough credits' })
  create(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @CurrentActor() actor: SessionActor, @Body() body: CreateGenerationDto) {
    return this.generations.request({
      workspaceId,
      requestedById: actor.userId,
      capability: body.capability,
      params: body.params,
      clientKey: body.clientKey,
      costCode: body.costCode,
    });
  }

  @Get()
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'History, newest first' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  history(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() query: GenerationHistoryQueryDto) {
    return this.generations.history(workspaceId, query.take, query.cursor);
  }

  @Get('/:generationId')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'One generation with its children and, if it failed, what to tell the customer' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiParam({ name: 'generationId', format: 'uuid' })
  get(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('generationId', ParseUUIDPipe) generationId: string) {
    return this.generations.get(workspaceId, generationId);
  }

  @Post('/:generationId/cancel')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Withdraw a generation that has not started; credits come back' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiParam({ name: 'generationId', format: 'uuid' })
  @ApiResponse({ status: 409, description: 'Already started' })
  cancel(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('generationId', ParseUUIDPipe) generationId: string) {
    return this.generations.cancel(generationId, workspaceId);
  }

  @Get('/:generationId/stream')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Server-sent events: stage, output and done, until the generation finishes' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiParam({ name: 'generationId', format: 'uuid' })
  async stream(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('generationId', ParseUUIDPipe) generationId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.generations.get(workspaceId, generationId); // 404 before the headers go out

    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    req.on('close', () => abort.abort());
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);

    try {
      for await (const event of this.events.watch(generationId, abort.signal)) {
        res.write(`event: ${event.type}\nid: ${event.at}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  }
}
