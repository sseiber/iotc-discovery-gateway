import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { ConfigService } from './config';
import { StorageService } from './storage';
import { ObjectDetectorDevice } from './objectDetectorDevice';
import { HealthState } from './health';
import { Mqtt } from 'azure-iot-device-mqtt';
import { SymmetricKeySecurityClient } from 'azure-iot-security-symmetric-key';
import { ProvisioningDeviceClient } from 'azure-iot-provisioning-device';
import { Mqtt as ProvisioningTransport } from 'azure-iot-provisioning-device-mqtt';
import {
    ModuleClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    arch as osArch,
    platform as osPlatform,
    release as osRelease,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
// import { promisify } from 'util';
// import { exec as processExec } from 'child_process';
import * as crypto from 'crypto';
import * as Wreck from '@hapi/wreck';
import { bind, defer, emptyObj, forget, sleep } from '../utils';

export interface IOnvifCamera {
    profile: string;
    location: string;
    model: string;
    name: string;
    scopeUris: string[];
    xaddrs: string[];
    uuid: string;
    ipAddress: string;
}

interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

interface IIoTCentralAppKeys {
    iotCentralAppHost: string;
    iotCentralAppApiToken: string;
    iotCentralDeviceProvisioningKey: string;
    iotCentralScopeId: string;
}

enum IotcEdgeHostProperties {
    Manufacturer = 'manufacturer',
    Model = 'model',
    SwVersion = 'swVersion',
    OsName = 'osName',
    ProcessorArchitecture = 'processorArchitecture',
    ProcessorManufacturer = 'processorManufacturer',
    TotalStorage = 'totalStorage',
    TotalMemory = 'totalMemory'
}

interface IProvisionResult {
    dpsProvisionStatus: boolean;
    dpsProvisionMessage: string;
    dpsHubConnectionString: string;
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
    deviceInstance: ObjectDetectorDevice;
}

enum IotcDiscoveryGatewaySettings {
    DebugTelemetry = 'wpDebugTelemetry'
}

interface IIotcDiscoveryGatewaySettings {
    [IotcDiscoveryGatewaySettings.DebugTelemetry]: boolean;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

enum AddDeviceRequestParams {
    DeviceId = 'AddDeviceRequestParams_DeviceId',
    DeviceName = 'AddDeviceRequestParams_DeviceName',
    RtspUrl = 'AddDeviceRequestParams_RtspUrl'
}

enum DeleteDeviceRequestParams {
    DeviceId = 'DeleteDeviceRequestParams_DeviceId'
}

enum ScanForDevicesRequestParams {
    ScanTime = 'ScanForDevicesRequestParams_ScanTime'
}

enum RestartModuleRequestParams {
    Timeout = 'RestartModuleRequestParams_Timeout'
}

enum CommandResponseParams {
    StatusCode = 'CommandResponseParams_StatusCode',
    Message = 'CommandResponseParams_Message',
    Data = 'CommandResponseParams_Data'
}

export const IotcDiscoveryGatewayInterface = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat',
        FreeMemory: 'tlFreeMemory',
        ConnectedDevices: 'tlConnectedDevices'
    },
    State: {
        IoTCentralClientState: 'stIoTCentralClientState',
        ModuleState: 'stModuleState'
    },
    Event: {
        ModuleStarted: 'evModuleStarted',
        ModuleStopped: 'evModuleStopped',
        ModuleRestart: 'evModuleRestart',
        CreateDevice: 'evCreateDevice',
        DeleteDevice: 'evDeleteDevice'
    },
    Setting: {
        DebugTelemetry: IotcDiscoveryGatewaySettings.DebugTelemetry
    },
    Command: {
        AddDevice: 'cmAddDevice',
        DeleteDevice: 'cmDeleteDevice',
        ScanForDevices: 'cmScanForDevices',
        RestartModule: 'cmRestartModule'
    }
};

const defaultDpsProvisioningHost: string = 'global.azure-devices-provisioning.net';
const defaultLeafDeviceModelId: string = 'urn:IoTCentral:ObjectDetectorDevice:1';
const defaultHealthCheckRetries: number = 3;

@service('module')
export class ModuleService {
    @inject('$server')
    private server: Server;

    @inject('config')
    private config: ConfigService;

    @inject('storage')
    private storage: StorageService;

    private moduleClient: ModuleClient = null;
    private moduleTwin: Twin = null;
    private iotEdgeDeviceId: string = '';
    private iotEdgeModuleId: string = '';
    private onvifModuleId: string = '';
    private deferredStart = defer();
    private healthState = HealthState.Good;
    private healthCheckFailStreak: number = 0;
    private moduleSettings: IIotcDiscoveryGatewaySettings = {
        [IotcDiscoveryGatewaySettings.DebugTelemetry]: false
    };
    private iotCentralAppKeys: IIoTCentralAppKeys = {
        iotCentralAppHost: '',
        iotCentralAppApiToken: '',
        iotCentralDeviceProvisioningKey: '',
        iotCentralScopeId: ''
    };
    private deviceMap = new Map<string, ObjectDetectorDevice>();
    private dpsProvisioningHost: string = defaultDpsProvisioningHost;
    private leafDeviceModelId: string = defaultLeafDeviceModelId;

    private healthCheckRetries: number = defaultHealthCheckRetries;

    public async init(): Promise<void> {
        this.server.log(['ModuleService', 'info'], 'initialize');

        this.server.method({ name: 'module.startModule', method: this.startModule });

        this.iotEdgeDeviceId = this.config.get('IOTEDGE_DEVICEID') || '';
        this.iotEdgeModuleId = this.config.get('IOTEDGE_MODULEID') || '';
        this.onvifModuleId = this.config.get('onvifModuleId') || '';

        this.healthCheckRetries = this.config.get('healthCheckRetries') || defaultHealthCheckRetries;
    }

    public debugTelemetry() {
        return this.moduleSettings[IotcDiscoveryGatewaySettings.DebugTelemetry];
    }

    @bind
    public async startModule(): Promise<void> {
        let result = true;

        try {
            result = await this.connectModuleClient();

            if (result === true) {
                await this.deferredStart.promise;

                await this.moduleReady();

                await this.recreateExistingDevices();
            }
        }
        catch (ex) {
            result = false;

            this.server.log(['ModuleService', 'error'], `Exception during IoT Central device provsioning: ${ex.message}`);
        }

        this.healthState = result === true ? HealthState.Good : HealthState.Critical;
    }

    @bind
    public async getHealth(): Promise<number> {
        let healthState = this.healthState;

        try {
            if (healthState === HealthState.Good) {
                const healthTelemetry = {};
                const systemProperties = await this.getSystemProperties();
                const freeMemory = systemProperties?.freeMemory || 0;

                healthTelemetry[IotcDiscoveryGatewayInterface.Telemetry.FreeMemory] = freeMemory;
                healthTelemetry[IotcDiscoveryGatewayInterface.Telemetry.ConnectedDevices] = this.deviceMap.size;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }

                healthTelemetry[IotcDiscoveryGatewayInterface.Telemetry.SystemHeartbeat] = healthState;

                await this.sendMeasurement(healthTelemetry);
            }

            this.healthState = healthState;

            for (const device of this.deviceMap) {
                forget(device[1].getHealth);
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error in healthState (may indicate a critical issue): ${ex.message}`);
            this.healthState = HealthState.Critical;
        }

        if (this.healthState < HealthState.Good) {
            this.server.log(['HealthService', 'warning'], `Health check warning: ${healthState}`);

            if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                this.server.log(['HealthService', 'warning'], `Health check too many warnings: ${healthState}`);

                await this.restartModule(0, 'checkHealthState');
            }
        }

        return this.healthState;
    }

    @bind
    public async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.moduleClient.sendEvent(iotcMessage);

            if (this.debugTelemetry() === true) {
                this.server.log(['ModuleService', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    public async updateModuleProperties(properties: any): Promise<void> {
        if (!properties || !this.moduleTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.moduleTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve();
                });
            });

            if (this.debugTelemetry() === true) {
                this.server.log(['ModuleService', 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    public async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log(['ModuleService', 'info'], `Module restart requested...`);

        try {
            await this.sendMeasurement({
                [IotcDiscoveryGatewayInterface.Event.ModuleRestart]: reason,
                [IotcDiscoveryGatewayInterface.State.ModuleState]: ModuleState.Inactive,
                [IotcDiscoveryGatewayInterface.Event.ModuleStopped]: 'Module restart'
            });

            if (timeout > 0) {
                await new Promise((resolve) => {
                    setTimeout(() => {
                        return resolve();
                    }, 1000 * timeout);
                });
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `${ex.message}`);
        }

        // let Docker restart our container
        this.server.log(['ModuleService', 'info'], `Shutting down main process - module container will restart`);
        process.exit(1);
    }

    private async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus?.length || 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }

    private async getEdgeDeviceProperties(): Promise<any> {
        let result = {};

        try {
            result = await this.storage.get('state', 'iotCentral.properties');
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error reading module properties: ${ex.message}`);
        }

        return result;
    }

    private async getIoTCentralAppKeys(): Promise<IIoTCentralAppKeys> {
        let result;

        try {
            result = await this.storage.get('state', 'iotCentral.appKeys');
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error reading app keys: ${ex.message}`);
        }

        return result;
    }

    private async connectModuleClient(): Promise<boolean> {
        let result = true;

        if (this.moduleClient) {
            await this.moduleClient.close();
            this.moduleClient = null;
            this.moduleTwin = null;
        }

        try {
            this.server.log(['ModuleService', 'info'], `IOTEDGE_WORKLOADURI: ${this.config.get('IOTEDGE_WORKLOADURI')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_DEVICEID: ${this.config.get('IOTEDGE_DEVICEID')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_MODULEID: ${this.config.get('IOTEDGE_MODULEID')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_MODULEGENERATIONID: ${this.config.get('IOTEDGE_MODULEGENERATIONID')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${this.config.get('IOTEDGE_IOTHUBHOSTNAME')}`);
            this.server.log(['ModuleService', 'info'], `IOTEDGE_AUTHSCHEME: ${this.config.get('IOTEDGE_AUTHSCHEME')}`);

            // TODO:
            // We need to hang out here for a bit of time to avoid a race condition where the edgeHub module is not
            // yet completely initialized. In the Edge runtime release 1.0.10-rc1 there is a new "priority" property
            // that can be used for modules that need to start up in a certain order.
            await sleep(15 * 1000);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message}`);
        }

        if (!this.moduleClient) {
            return false;
        }

        try {
            await this.moduleClient.open();

            this.server.log(['ModuleService', 'info'], `Client is connected`);

            // TODO:
            // Should the module twin interface get connected *BEFORE* opening
            // the moduleClient above?
            this.moduleTwin = await this.moduleClient.getTwin();
            this.moduleTwin.on('properties.desired', this.onHandleModuleProperties);

            this.moduleClient.on('error', this.onModuleClientError);

            this.moduleClient.onMethod(IotcDiscoveryGatewayInterface.Command.AddDevice, this.addDeviceDirectMethod);
            this.moduleClient.onMethod(IotcDiscoveryGatewayInterface.Command.DeleteDevice, this.deleteDeviceDirectMethod);
            this.moduleClient.onMethod(IotcDiscoveryGatewayInterface.Command.ScanForDevices, this.scanForDevicesDirectMethod);
            this.moduleClient.onMethod(IotcDiscoveryGatewayInterface.Command.RestartModule, this.restartModuleDirectMethod);

            this.server.log(['ModuleService', 'info'], `IoT Central successfully connected module: ${this.config.get('IOTEDGE_MODULEID')}, instance id: ${this.config.get('IOTEDGE_DEVICEID')}`);
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `IoT Central connection error: ${ex.message}`);

            result = false;
        }

        return result;
    }

    private async moduleReady(): Promise<void> {
        this.server.log(['ModuleService', 'info'], `Module ready`);

        const systemProperties = await this.getSystemProperties();
        const moduleProperties = await this.getEdgeDeviceProperties();
        this.iotCentralAppKeys = await this.getIoTCentralAppKeys();

        await this.updateModuleProperties({
            ...moduleProperties,
            [IotcEdgeHostProperties.OsName]: osPlatform() || '',
            [IotcEdgeHostProperties.SwVersion]: osRelease() || '',
            [IotcEdgeHostProperties.ProcessorArchitecture]: osArch() || '',
            [IotcEdgeHostProperties.TotalMemory]: systemProperties.totalMemory
        });

        await this.sendMeasurement({
            [IotcDiscoveryGatewayInterface.State.IoTCentralClientState]: IoTCentralClientState.Connected,
            [IotcDiscoveryGatewayInterface.State.ModuleState]: ModuleState.Active,
            [IotcDiscoveryGatewayInterface.Event.ModuleStarted]: 'Module initialization'
        });
    }

    private async recreateExistingDevices() {
        this.server.log(['ModuleService', 'info'], 'recreateExistingDevices');

        try {
            const deviceListResponse = await this.makeRequest(
                `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices`,
                'get',
                {
                    headers: {
                        Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                    },
                    json: true
                });

            const deviceList = deviceListResponse.payload?.value || [];

            this.server.log(['ModuleService', 'info'], `Found ${deviceList.length} devices`);
            if (this.debugTelemetry() === true) {
                this.server.log(['ModuleService', 'info'], `${JSON.stringify(deviceList, null, 4)}`);
            }

            for (const device of deviceList) {
                try {
                    this.server.log(['ModuleService', 'info'], `Getting properties for device: ${device.id}`);

                    const devicePropertiesResponse = await this.makeRequest(
                        `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices/${device.id}/properties`,
                        'get',
                        {
                            headers: {
                                Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                            },
                            json: true
                        });

                    if (devicePropertiesResponse?.payload?.IotcObjectDetectorInterface) {
                        const deviceInterfaceProperties = devicePropertiesResponse.payload.IotcObjectDetectorInterface;

                        this.server.log(['ModuleService', 'info'], `Recreating device: ${device.id}`);

                        await this.createDevice(device.id, deviceInterfaceProperties.rpDeviceName, deviceInterfaceProperties.rpRtspUrl);
                    }
                    else {
                        this.server.log(['ModuleService', 'info'], `Found device: ${device.id} - but it is not a Discovery Gateway device`);
                    }
                }
                catch (ex) {
                    this.server.log(['ModuleService', 'error'], `An error occurred while re-creating devices: ${ex.message}`);
                }
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Failed to get device list: ${ex.message}`);
        }

        // If there were errors, we may be in a bad state (e.g. an ams inference device exists
        // but we were not able to re-connect to it's client interface). Consider setting the health
        // state to critical here to restart the gateway module.
    }

    @bind
    private onModuleClientError(error: Error) {
        this.server.log(['ModuleService', 'error'], `Module client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any) {
        try {
            this.server.log(['ModuleService', 'info'], `onHandleModuleProperties`);
            if (this.debugTelemetry() === true) {
                this.server.log(['ModuleService', 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!desiredChangedSettings.hasOwnProperty(setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[setting];

                switch (setting) {
                    case IotcDiscoveryGatewayInterface.Setting.DebugTelemetry:
                        patchedProperties[setting] = (this.moduleSettings[setting] as any) = value || false;
                        break;

                    default:
                        this.server.log(['ModuleService', 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    private async invokeOnvifDirectMethod(methodName: string, payload: any): Promise<any> {
        const methodParams = {
            methodName,
            payload,
            connectTimeoutInSeconds: 30,
            responseTimeoutInSeconds: 30
        };

        const response = await this.moduleClient.invokeMethod(this.iotEdgeDeviceId, this.onvifModuleId, methodParams);
        if (this.debugTelemetry() === true) {
            this.server.log(['ModuleService', 'info'], `invokeOnvifDirectMethod response: ${JSON.stringify(response, null, 4)}`);
        }

        if (response.payload?.error) {
            // throw new Error(`(from invokeMethod) ${response.payload.error?.message}`);
            this.server.log(['ModuleService', 'error'], `invokeOnvifDirectMethod error: ${response.payload.error?.message}`);

            return {
                status: response.status,
                payload: response.payload
            };
        }

        return {
            status: response.status,
            payload: {}
        };
    }

    // TODO:
    // Move this into a separate plugin

    // private async scanForDevices(scanTime: number): Promise<IOnvifCamera[]> {
    //     try {
    //         const hostDefaultRoute = await this.getHostDefaultRoute();
    //         const scanMilliseconds = scanTime < 0 || scanTime > 60 ? 5000 : scanTime * 1000;

    //         this.server.log(['ModuleService', 'info'], `Starting network device scan for ${scanTime} seconds...`);

    //         const discoveryResponse = await this.makeRequest(
    //             `http://${hostDefaultRoute}:5000/api/discovery/discover/${scanMilliseconds}`,
    //             'post',
    //             {
    //                 json: true
    //             });

    //         const onvifDiscoveryResult = discoveryResponse?.payload || [];
    //         if (Array.isArray(onvifDiscoveryResult)) {
    //             this.server.log(['ModuleService', 'info'], `Finished network device scan - found ${onvifDiscoveryResult.length} devices`);

    //             if (this.debugTelemetry() === true) {
    //                 this.server.log(['ModuleService', 'info'], JSON.stringify(onvifDiscoveryResult, null, 4));
    //             }

    //             const discoveryResult = onvifDiscoveryResult.map((value): IOnvifCamera => {
    //                 return {
    //                     profile: value?.profile.join(',') || '',
    //                     location: '',
    //                     model: value?.hardware?.[0] || 'Unknown',
    //                     name: value?.name?.[0] || 'Unknown',
    //                     scopeUris: [
    //                         ...value?.scopeUris
    //                     ],
    //                     xaddrs: [
    //                         ...value?.xaddrs
    //                     ],
    //                     uuid: value?.uuid || '',
    //                     ipAddress: value?.remoteAddress || ''
    //                 };
    //             });

    //             return discoveryResult;
    //         }
    //     }
    //     catch (ex) {
    //         this.server.log(['ModuleService', 'error'], `Exception while handling desired properties: ${ex.message}`);
    //     }

    //     return [];
    // }

    private async createDevice(deviceId: string, deviceName: string, rtspUrl: string): Promise<IProvisionResult> {
        this.server.log(['ModuleService', 'info'], `createDevice - deviceId: ${deviceId}, deviceName: ${deviceName}, rtspUrl: ${rtspUrl}`);

        let deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            deviceInstance: null
        };

        try {
            if (!deviceId) {
                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device configuration - skipping DPS provisioning`;

                this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            if (!this.iotCentralAppKeys.iotCentralAppHost
                || !this.iotCentralAppKeys.iotCentralAppApiToken
                || !this.iotCentralAppKeys.iotCentralDeviceProvisioningKey
                || !this.iotCentralAppKeys.iotCentralScopeId) {

                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing device management settings (ScopeId)`;
                this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionDevice(deviceId, deviceName, rtspUrl);

            if (deviceProvisionResult.dpsProvisionStatus === true && deviceProvisionResult.clientConnectionStatus === true) {
                this.deviceMap.set(deviceId, deviceProvisionResult.deviceInstance);

                await this.sendMeasurement({ [IotcDiscoveryGatewayInterface.Event.CreateDevice]: deviceId });

                this.server.log(['ModuleService', 'info'], `Succesfully provisioned device with id: ${deviceId}`);
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionDevice(deviceId: string, deviceName: string, rtspUrl: string): Promise<IProvisionResult> {
        this.server.log(['ModuleService', 'info'], `Provisioning device - id: ${deviceId}`);

        const deviceProvisionResult: IProvisionResult = {
            dpsProvisionStatus: false,
            dpsProvisionMessage: '',
            dpsHubConnectionString: '',
            clientConnectionStatus: false,
            clientConnectionMessage: '',
            deviceInstance: null
        };

        try {
            const deviceKey = this.computeDeviceKey(deviceId, this.iotCentralAppKeys.iotCentralDeviceProvisioningKey);
            this.server.log(['ModuleService', 'info'], `Computed deviceKey: ${deviceKey}`);

            const provisioningSecurityClient = new SymmetricKeySecurityClient(deviceId, deviceKey);
            const provisioningClient = ProvisioningDeviceClient.create(
                this.dpsProvisioningHost,
                this.iotCentralAppKeys.iotCentralScopeId,
                new ProvisioningTransport(),
                provisioningSecurityClient);

            this.server.log(['ModuleService', 'info'], `Created provisioningClient succeeded`);

            const provisioningPayload = {
                iotcModelId: this.leafDeviceModelId,
                iotcGateway: {
                    iotcGatewayId: this.iotEdgeDeviceId,
                    iotcModuleId: this.iotEdgeModuleId
                }
            };

            provisioningClient.setProvisioningPayload(provisioningPayload);
            this.server.log(['ModuleService', 'info'], `setProvisioningPayload succeeded ${JSON.stringify(provisioningPayload, null, 4)}`);

            const dpsConnectionString = await new Promise<string>((resolve, reject) => {
                provisioningClient.register((dpsError, dpsResult) => {
                    if (dpsError) {
                        return reject(dpsError);
                    }

                    this.server.log(['ModuleService', 'info'], `DPS registration succeeded - hub: ${dpsResult.assignedHub}`);

                    return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceKey}`);
                });
            });
            this.server.log(['ModuleService', 'info'], `register device client succeeded`);

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${deviceId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            deviceProvisionResult.deviceInstance = new ObjectDetectorDevice(this.server, this.config, deviceId, deviceName, rtspUrl);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.deviceInstance.connectDeviceClient(deviceProvisionResult.dpsHubConnectionString);

            this.server.log(['ModuleService', 'info'], `clientConnectionStatus: ${clientConnectionStatus}, clientConnectionMessage: ${clientConnectionMessage}`);

            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log(['ModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async deprovisionDevice(deviceId: string): Promise<boolean> {
        this.server.log(['ModuleService', 'info'], `Deprovisioning device - id: ${deviceId}`);

        let result = false;

        try {
            const deviceInstance = this.deviceMap.get(deviceId);
            if (deviceInstance) {
                await deviceInstance.deleteDevice();
                this.deviceMap.delete(deviceId);
            }

            this.server.log(['ModuleService', 'info'], `Deleting IoT Central device instance: ${deviceId}`);
            try {
                await this.makeRequest(
                    `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices/${deviceId}`,
                    'delete',
                    {
                        headers: {
                            Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                        },
                        json: true
                    });

                await this.sendMeasurement({ [IotcDiscoveryGatewayInterface.Event.DeleteDevice]: deviceId });

                this.server.log(['ModuleService', 'info'], `Succesfully de-provisioned device with id: ${deviceId}`);

                result = true;
            }
            catch (ex) {
                this.server.log(['ModuleService', 'error'], `Requeset to delete the IoT Central device failed: ${ex.message}`);
            }
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Failed de-provision device: ${ex.message}`);
        }

        return result;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    @bind
    private async addDeviceDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.AddDevice} command received`);

        try {
            const deviceId = commandRequest?.payload?.[AddDeviceRequestParams.DeviceId];
            const deviceName = commandRequest?.payload?.[AddDeviceRequestParams.DeviceName];
            const rtspUrl = commandRequest?.payload?.[AddDeviceRequestParams.RtspUrl];

            if (!deviceId || !deviceName || !rtspUrl) {
                await commandResponse.send(202);
                await this.updateModuleProperties({
                    [IotcDiscoveryGatewayInterface.Command.AddDevice]: {
                        value: {
                            [CommandResponseParams.StatusCode]: 202,
                            [CommandResponseParams.Message]: `The ${IotcDiscoveryGatewayInterface.Command.AddDevice} command is missing required parameters, deviceId, deviceName, rtspUrl`,
                            [CommandResponseParams.Data]: ''
                        }
                    }
                });

                return;
            }

            const provisionResult = await this.createDevice(deviceId, deviceName, rtspUrl);

            await commandResponse.send(202);
            await this.updateModuleProperties({
                [IotcDiscoveryGatewayInterface.Command.AddDevice]: {
                    value: {
                        [CommandResponseParams.StatusCode]: 202,
                        [CommandResponseParams.Message]: provisionResult.clientConnectionMessage,
                        [CommandResponseParams.Data]: ''
                    }
                }
            });
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error creating device: ${ex.message}`);
        }
    }

    @bind
    private async deleteDeviceDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.DeleteDevice} command received`);

        try {
            const deviceId = commandRequest?.payload?.[DeleteDeviceRequestParams.DeviceId];
            if (!deviceId) {
                await commandResponse.send(202);
                await this.updateModuleProperties({
                    [IotcDiscoveryGatewayInterface.Command.DeleteDevice]: {
                        [CommandResponseParams.StatusCode]: 202,
                        [CommandResponseParams.Message]: `The ${IotcDiscoveryGatewayInterface.Command.DeleteDevice} command requires a Device Id parameter`,
                        [CommandResponseParams.Data]: ''
                    }
                });

                return;
            }

            const deleteResult = await this.deprovisionDevice(deviceId);

            await commandResponse.send(202);
            await this.updateModuleProperties({
                [IotcDiscoveryGatewayInterface.Command.DeleteDevice]: {
                    value: {
                        [CommandResponseParams.StatusCode]: 202,
                        [CommandResponseParams.Message]: deleteResult
                            ? `The ${IotcDiscoveryGatewayInterface.Command.DeleteDevice} command succeeded`
                            : `An error occurred while executing the ${IotcDiscoveryGatewayInterface.Command.DeleteDevice} command`,
                        [CommandResponseParams.Data]: ''
                    }
                }
            });
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error deleting device: ${ex.message}`);
        }
    }

    @bind
    private async scanForDevicesDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.ScanForDevices} command received`);

        try {
            const scanTimeout = commandRequest?.payload?.[ScanForDevicesRequestParams.ScanTime] || 5;

            const scanResult = await this.invokeOnvifDirectMethod('discover', {
                timeout: scanTimeout < 0 || scanTimeout > 60 ? 5000 : scanTimeout * 1000
            });

            await commandResponse.send(202);
            await this.updateModuleProperties({
                [IotcDiscoveryGatewayInterface.Command.ScanForDevices]: {
                    value: {
                        [CommandResponseParams.StatusCode]: 202,
                        [CommandResponseParams.Message]: scanResult.status === 200
                            ? `The ${IotcDiscoveryGatewayInterface.Command.ScanForDevices} command succeeded`
                            : `An error occurred while executing the ${IotcDiscoveryGatewayInterface.Command.ScanForDevices} command`,
                        [CommandResponseParams.Data]: JSON.stringify(scanResult.payload, null, 4)
                    }
                }
            });
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error while scanning for devices: ${ex.message}`);
        }
    }

    @bind
    private async restartModuleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.RestartModule} command received`);

        try {
            // sending response before processing, since this is a restart request
            await commandResponse.send(200);
            await this.updateModuleProperties({
                [IotcDiscoveryGatewayInterface.Command.RestartModule]: {
                    value: {
                        [CommandResponseParams.StatusCode]: 202,
                        [CommandResponseParams.Message]: 'Received command to restart the module',
                        [CommandResponseParams.Data]: ''
                    }
                }
            });

            await this.restartModule(commandRequest?.payload?.[RestartModuleRequestParams.Timeout] || 0, 'RestartModule command received');
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `Error sending response for ${IotcDiscoveryGatewayInterface.Command.RestartModule} command: ${ex.message}`);
        }
    }

    // private async getHostDefaultRoute(): Promise<string> {
    //     let defaultRoute = '';

    //     try {
    //         const { stdout } = await promisify(processExec)(`route | awk '/default/ {print $2}'`, { encoding: 'utf8' });

    //         defaultRoute = (stdout || '127.0.0.1').trim();

    //         this.server.log(['ModuleService', 'info'], `Determined host default route: ${stdout}`);
    //     }
    //     catch (ex) {
    //         this.server.log(['ModuleService', 'info'], `getHostDefaultRoute stderr: ${ex.message}`);
    //     }

    //     return defaultRoute;
    // }

    private async makeRequest(uri, method, options): Promise<any> {
        if (this.debugTelemetry() === true) {
            this.server.log(['ModuleService', 'info'], `Calling api: ${method} - ${uri}`);
        }

        try {
            const iotcApiResponse = await Wreck[method](uri, options);

            if (iotcApiResponse.res.statusCode < 200 || iotcApiResponse.res.statusCode > 299) {
                this.server.log(['ModuleService', 'error'], `Response status code = ${iotcApiResponse.res.statusCode}`);

                throw ({
                    message: (iotcApiResponse.payload as any)?.message || iotcApiResponse.payload || 'An error occurred',
                    statusCode: iotcApiResponse.res.statusCode
                });
            }

            return iotcApiResponse;
        }
        catch (ex) {
            this.server.log(['ModuleService', 'error'], `makeRequest: ${ex.message}`);
            throw ex;
        }
    }
}
