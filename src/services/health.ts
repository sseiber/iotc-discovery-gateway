import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { IoTCentralModuleService } from './iotcModule';
import { bind } from '../utils';

export const healthCheckInterval = 15;
// const healthCheckTimeout = 30;
// const healthCheckStartPeriod = 60;
// const healthCheckRetries = 3;

export const HealthState = {
    Good: 2,
    Warning: 1,
    Critical: 0
};

@service('health')
export class HealthService {
    @inject('$server')
    private server: Server;

    @inject('iotcModule')
    private iotcModule: IoTCentralModuleService;

    // private heathCheckStartTime = Date.now();
    // private failingStreak = 1;

    public async init() {
        this.server.log(['HealthService', 'info'], 'initialize');
    }

    @bind
    public async checkHealthState(): Promise<number> {
        this.server.log(['HealthService', 'info'], 'Health check interval');

        const moduleHealth = await this.iotcModule.getHealth();

        return moduleHealth;
    }
}
