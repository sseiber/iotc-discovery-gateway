import { manifest } from './manifest';
import { compose, ComposeOptions } from 'spryly';
import {
    type as osType,
    cpus as osCpus,
    freemem as osFreeMem,
    totalmem as osTotalMem
} from 'os';
import { forget } from './utils';

const composeOptions: ComposeOptions = {
    relativeTo: __dirname,
    logCompose: {
        serializers: {
            req: (req) => {
                return `${(req.method || '').toUpperCase()} ${req.url?.origin} ${req.url?.pathname}`;
            },
            res: (res) => {
                return `${res.statusCode} ${res.raw?.statusMessage}`;
            },
            tags: (tags) => {
                return `[${tags}]`;
            },
            responseTime: (responseTime) => {
                return `${responseTime}ms`;
            }
        },
        prettyPrint: {
            colorize: true,
            messageFormat: '{tags} {data} {req} {res} {responseTime}',
            translateTime: 'SYS:yyyy-mm-dd"T"HH:MM:sso',
            ignore: 'pid,hostname,tags,data,req,res,responseTime'
        }
    }
};

// process.on('unhandledRejection', (e: any) => {
//     // tslint:disable:no-console
//     console.log(['startup', 'error'], `Excepction on startup... ${e.message}`);
//     console.log(['startup', 'error'], e.stack);
//     // tslint:enable:no-console
// });

async function start() {
    try {
        const server = await compose(manifest(), composeOptions);

        server.log(['startup', 'info'], `🚀 Starting HAPI server instance...`);

        await server.start();

        server.log(['startup', 'info'], `✅ Core server started`);
        server.log(['startup', 'info'], `🌎 ${server.info.uri}`);
        server.log(['startup', 'info'], ` > Hapi version: ${server.version}`);
        server.log(['startup', 'info'], ` > Plugins: [${Object.keys(server.registrations).join(', ')}]`);
        server.log(['startup', 'info'], ` > Machine: ${osType()}, ${osCpus().length} core, ` +
            `freemem=${(osFreeMem() / 1024 / 1024).toFixed(0)}mb, totalmem=${(osTotalMem() / 1024 / 1024).toFixed(0)}mb`);

        server.log(['startup', 'info'], `📷 Starting module initialzation`);
        await (server.methods.module as any).startModule();
        server.log(['startup', 'info'], `📸 Finished module initialization`);
    }
    catch (error) {
        // tslint:disable-next-line:no-console
        console.log(`['startup', 'error'], 👹 Error starting server: ${error.message}`);
    }
}

forget(start);
