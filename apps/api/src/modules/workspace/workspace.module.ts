import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceService } from './workspace.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({ imports: [LedgerModule], controllers: [WorkspaceController, WorkspacesController], providers: [WorkspaceService] })
export class WorkspaceModule {}
