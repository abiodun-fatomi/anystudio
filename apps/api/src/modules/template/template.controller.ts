import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TemplateService } from './template.service';

@ApiTags('templates')
@ApiCookieAuth('session')
@Controller({ version: '1' })
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}

  /**
   * Signed-in but not workspace-scoped, exactly like the voice and genre
   * catalogues next door: the list is the same for everybody, and the
   * thumbnails it signs are catalogue art with no owner. Nothing here reveals
   * anything about a workspace, so asking which workspace is asking would
   * only make the studio pass an id it does not otherwise need.
   */
  @Get('/templates')
  @ApiOperation({ summary: 'Settings a seller can pick by looking — the template catalogue' })
  list() {
    return this.templates.list();
  }
}
