import { Server } from '@hapi/hapi';
import { HapiPlugin, service } from 'spryly';
import * as nconf from 'nconf';

@service('config')
export class ConfigService {
    private config: nconf.Provider;

    public async init() {
        this.config = nconf.env().file(`./configs/${process.env.NODE_ENV}.json`);
    }

    public get(key: string): any {
        return this.config.get(key);
    }
}

export class ConfigPlugin implements HapiPlugin {
    public async register(server: Server) {
        await server.register({
            plugin: Nes,
            options: {
                onConnection: this.loopBoxProxy.clientConnection.bind(this.loopBoxProxy),
                onDisconnection: this.loopBoxProxy.clientDisconnection.bind(this.loopBoxProxy),
                onMessage: this.loopBoxProxy.clientMessageResponse.bind(this.loopBoxProxy),
                auth: false,
                heartbeat: {
                    interval: 10000,
                    timeout: 5000
                }
            }
        });
    }
}
