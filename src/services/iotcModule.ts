import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { ConfigService } from './config';
import { StorageService } from './storage';
import { IotcObjectDetectorDevice } from './objectDetectorDevice';
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
import * as crypto from 'crypto';
import * as Wreck from '@hapi/wreck';
import { bind, defer, emptyObj, forget, sleep } from '../utils';

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
    deviceInstance: IotcObjectDetectorDevice;
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
const defaultLeafDeviceModelId: string = 'urn:IoTCentral:IotcObjectDetectorDevice:1';
const defaultHealthCheckRetries: number = 3;

@service('iotcModule')
export class IoTCentralModuleService {
    @inject('$server')
    private server: Server;

    @inject('config')
    private config: ConfigService;

    @inject('storage')
    private storage: StorageService;

    private moduleClient: ModuleClient = null;
    private moduleTwin: Twin = null;
    private moduleInstanceId: string = '';
    private moduleId: string = '';
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
    private deviceMap = new Map<string, IotcObjectDetectorDevice>();
    private dpsProvisioningHost: string = defaultDpsProvisioningHost;
    private leafDeviceModelId: string = defaultLeafDeviceModelId;

    private healthCheckRetries: number = defaultHealthCheckRetries;

    public async init(): Promise<void> {
        this.server.log(['IoTCentralModuleService', 'info'], 'initialize');

        this.server.method({ name: 'module.startModule', method: this.startModule });

        this.moduleInstanceId = this.config.get('IOTEDGE_DEVICEID') || '';
        this.moduleId = this.config.get('IOTEDGE_MODULEID') || '';

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

            this.server.log(['IoTCentralModuleService', 'error'], `Exception during IoT Central device provsioning: ${ex.message}`);
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
            this.server.log(['IoTCentralModuleService', 'error'], `Error in healthState (may indicate a critical issue): ${ex.message}`);
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
                this.server.log(['IoTCentralModuleService', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `sendMeasurement: ${ex.message}`);
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
                this.server.log(['IoTCentralModuleService', 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    public async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log(['IoTCentralModuleService', 'info'], `Module restart requested...`);

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
            this.server.log(['IoTCentralModuleService', 'error'], `${ex.message}`);
        }

        // let Docker restart our container
        this.server.log(['IoTCentralModuleService', 'info'], `Shutting down main process - module container will restart`);
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
            this.server.log(['IoTCentralModuleService', 'error'], `Error reading module properties: ${ex.message}`);
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
            this.server.log(['IoTCentralModuleService', 'info'], `IOTEDGE_WORKLOADURI: ${this.config.get('IOTEDGE_WORKLOADURI')}`);
            this.server.log(['IoTCentralModuleService', 'info'], `IOTEDGE_DEVICEID: ${this.config.get('IOTEDGE_DEVICEID')}`);
            this.server.log(['IoTCentralModuleService', 'info'], `IOTEDGE_MODULEID: ${this.config.get('IOTEDGE_MODULEID')}`);
            this.server.log(['IoTCentralModuleService', 'info'], `IOTEDGE_MODULEGENERATIONID: ${this.config.get('IOTEDGE_MODULEGENERATIONID')}`);
            this.server.log(['IoTCentralModuleService', 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${this.config.get('IOTEDGE_IOTHUBHOSTNAME')}`);
            this.server.log(['IoTCentralModuleService', 'info'], `IOTEDGE_AUTHSCHEME: ${this.config.get('IOTEDGE_AUTHSCHEME')}`);

            // TODO:
            // We need to hang out here for a bit of time to avoid a race condition where the edgeHub module is not
            // yet completely initialized. In the Edge runtime release 1.0.10-rc1 there is a new "priority" property
            // that can be used for modules that need to start up in a certain order.
            await sleep(15 * 1000);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message}`);
        }

        if (!this.moduleClient) {
            return false;
        }

        try {
            await this.moduleClient.open();

            this.server.log(['IoTCentralModuleService', 'info'], `Client is connected`);

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

            this.server.log(['IoTCentralModuleService', 'info'], `IoT Central successfully connected module: ${this.config.get('IOTEDGE_MODULEID')}, instance id: ${this.config.get('IOTEDGE_DEVICEID')}`);
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `IoT Central connection error: ${ex.message}`);

            result = false;
        }

        return result;
    }

    private async moduleReady(): Promise<void> {
        this.server.log(['IoTCentralModuleService', 'info'], `Module ready`);

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
        this.server.log(['IoTCentralModuleService', 'info'], 'recreateExistingDevices');

        try {
            if (this.debugTelemetry() === true) {
                this.server.log(['IoTCentralModuleService', 'info'], `Calling api: https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices`);
            }

            const deviceListResponse = await this.iotcApiRequest(
                `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices`,
                'get',
                {
                    headers: {
                        Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                    },
                    json: true
                });

            const deviceList = deviceListResponse.payload?.value || [];

            this.server.log(['IoTCentralModuleService', 'info'], `Found ${deviceList.length} devices`);
            if (this.debugTelemetry() === true) {
                this.server.log(['IoTCentralModuleService', 'info'], `${JSON.stringify(deviceList, null, 4)}`);
            }

            for (const device of deviceList) {
                try {
                    this.server.log(['IoTCentralModuleService', 'info'], `Getting properties for device: ${device.id}`);
                    if (this.debugTelemetry() === true) {
                        this.server.log(['IoTCentralModuleService', 'info'], `Calling api: https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices/${device.id}/properties`);
                    }

                    const devicePropertiesResponse = await this.iotcApiRequest(
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

                        this.server.log(['IoTCentralModuleService', 'info'], `Recreating device: ${device.id}`);

                        await this.createDevice(device.id, deviceInterfaceProperties.rpDeviceName, deviceInterfaceProperties.rpRtspUrl);
                    }
                    else {
                        this.server.log(['IoTCentralModuleService', 'info'], `Found device: ${device.id} - but it is not an AMS camera device`);
                    }
                }
                catch (ex) {
                    this.server.log(['IoTCentralModuleService', 'error'], `An error occurred while re-creating devices: ${ex.message}`);
                }
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `Failed to get device list: ${ex.message}`);
        }

        // If there were errors, we may be in a bad state (e.g. an ams inference device exists
        // but we were not able to re-connect to it's client interface). Consider setting the health
        // state to critical here to restart the gateway module.
    }

    @bind
    private onModuleClientError(error: Error) {
        this.server.log(['IoTCentralModuleService', 'error'], `Module client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any) {
        try {
            this.server.log(['IoTCentralModuleService', 'info'], `onHandleModuleProperties`);
            if (this.debugTelemetry() === true) {
                this.server.log(['IoTCentralModuleService', 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
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
                        this.server.log(['IoTCentralModuleService', 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    private async scanForDevices(scanTime: number): Promise<string> {
        try {
            this.server.log(['IoTCentralModuleService', 'info'], `Starting network device scan for ${scanTime} seconds...`);

            await new Promise((resolve) => {
                setTimeout(() => {
                    return resolve();
                }, scanTime);
            });

            const deviceCount = 2;

            this.server.log(['IoTCentralModuleService', 'info'], `Finished network device scan - found ${deviceCount} devices`);

            const scanResult = {
                ['192.168.86.75']: {
                    name: 'axis1367',
                    profile: 'stream1',
                    resolution: '1920x1080'
                },
                ['192.168.86.82']: {
                    name: 'hikvision',
                    profile: 'channel2',
                    resolution: '1280x720'
                }
            };

            const commandResult = JSON.stringify(scanResult);

            return commandResult;
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    private async createDevice(deviceId: string, deviceName: string, rtspUrl: string): Promise<IProvisionResult> {
        this.server.log(['IoTCentralModuleService', 'info'], `createDevice - deviceId: ${deviceId}, deviceName: ${deviceName}, detectionType: ${rtspUrl}`);

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

                this.server.log(['IoTCentralModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            if (!this.iotCentralAppKeys.iotCentralAppHost
                || !this.iotCentralAppKeys.iotCentralAppApiToken
                || !this.iotCentralAppKeys.iotCentralDeviceProvisioningKey
                || !this.iotCentralAppKeys.iotCentralScopeId) {

                deviceProvisionResult.dpsProvisionStatus = false;
                deviceProvisionResult.dpsProvisionMessage = `Missing camera management settings (ScopeId)`;
                this.server.log(['IoTCentralModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);

                return deviceProvisionResult;
            }

            deviceProvisionResult = await this.createAndProvisionDevice(deviceId, deviceName, rtspUrl);

            if (deviceProvisionResult.dpsProvisionStatus === true && deviceProvisionResult.clientConnectionStatus === true) {
                this.deviceMap.set(deviceId, deviceProvisionResult.deviceInstance);

                await this.sendMeasurement({ [IotcDiscoveryGatewayInterface.Event.CreateDevice]: deviceId });

                this.server.log(['IoTCentralModuleService', 'info'], `Succesfully provisioned device with id: ${deviceId}`);
            }
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log(['IoTCentralModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async createAndProvisionDevice(deviceId: string, deviceName: string, rtspUrl: string): Promise<IProvisionResult> {
        this.server.log(['IoTCentralModuleService', 'info'], `Provisioning device - id: ${deviceId}`);

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
            this.server.log(['IoTCentralModuleService', 'info'], `Computed deviceKey: ${deviceKey}`);

            const provisioningSecurityClient = new SymmetricKeySecurityClient(deviceId, deviceKey);
            const provisioningClient = ProvisioningDeviceClient.create(
                this.dpsProvisioningHost,
                this.iotCentralAppKeys.iotCentralScopeId,
                new ProvisioningTransport(),
                provisioningSecurityClient);

            this.server.log(['IoTCentralModuleService', 'info'], `Created provisioningClient succeeded`);

            const provisioningPayload = {
                iotcModelId: this.leafDeviceModelId,
                iotcGateway: {
                    iotcGatewayId: this.moduleInstanceId,
                    iotcModuleId: this.moduleId
                }
            };

            provisioningClient.setProvisioningPayload(provisioningPayload);
            this.server.log(['IoTCentralModuleService', 'info'], `setProvisioningPayload succeeded ${JSON.stringify(provisioningPayload, null, 4)}`);

            const dpsConnectionString = await new Promise<string>((resolve, reject) => {
                provisioningClient.register((dpsError, dpsResult) => {
                    if (dpsError) {
                        return reject(dpsError);
                    }

                    this.server.log(['IoTCentralModuleService', 'info'], `DPS registration succeeded - hub: ${dpsResult.assignedHub}`);

                    return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceKey}`);
                });
            });
            this.server.log(['IoTCentralModuleService', 'info'], `register device client succeeded`);

            deviceProvisionResult.dpsProvisionStatus = true;
            deviceProvisionResult.dpsProvisionMessage = `IoT Central successfully provisioned device: ${deviceId}`;
            deviceProvisionResult.dpsHubConnectionString = dpsConnectionString;

            deviceProvisionResult.deviceInstance = new IotcObjectDetectorDevice(this.server, this.config, deviceId, deviceName, rtspUrl);

            const { clientConnectionStatus, clientConnectionMessage } = await deviceProvisionResult.deviceInstance.connectDeviceClient(deviceProvisionResult.dpsHubConnectionString);

            this.server.log(['IoTCentralModuleService', 'info'], `clientConnectionStatus: ${clientConnectionStatus}, clientConnectionMessage: ${clientConnectionMessage}`);

            deviceProvisionResult.clientConnectionStatus = clientConnectionStatus;
            deviceProvisionResult.clientConnectionMessage = clientConnectionMessage;
        }
        catch (ex) {
            deviceProvisionResult.dpsProvisionStatus = false;
            deviceProvisionResult.dpsProvisionMessage = `Error while provisioning device: ${ex.message}`;

            this.server.log(['IoTCentralModuleService', 'error'], deviceProvisionResult.dpsProvisionMessage);
        }

        return deviceProvisionResult;
    }

    private async deprovisionDevice(deviceId: string): Promise<boolean> {
        this.server.log(['IoTCentralModuleService', 'info'], `Deprovisioning device - id: ${deviceId}`);

        let result = false;

        try {
            const deviceInstance = this.deviceMap.get(deviceId);
            if (deviceInstance) {
                await deviceInstance.deleteDevice();
                this.deviceMap.delete(deviceId);
            }

            this.server.log(['IoTCentralModuleService', 'info'], `Deleting IoT Central device instance: ${deviceId}`);
            try {
                await this.iotcApiRequest(
                    `https://${this.iotCentralAppKeys.iotCentralAppHost}/api/preview/devices/${deviceId}`,
                    'delete',
                    {
                        headers: {
                            Authorization: this.iotCentralAppKeys.iotCentralAppApiToken
                        },
                        json: true
                    });

                await this.sendMeasurement({ [IotcDiscoveryGatewayInterface.Event.DeleteDevice]: deviceId });

                this.server.log(['IoTCentralModuleService', 'info'], `Succesfully de-provisioned camera device with id: ${deviceId}`);

                result = true;
            }
            catch (ex) {
                this.server.log(['IoTCentralModuleService', 'error'], `Requeset to delete the IoT Central device failed: ${ex.message}`);
            }
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `Failed de-provision device: ${ex.message}`);
        }

        return result;
    }

    private computeDeviceKey(deviceId: string, masterKey: string) {
        return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64')).update(deviceId, 'utf8').digest('base64');
    }

    @bind
    private async addDeviceDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.AddDevice} command received`);

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
            this.server.log(['IoTCentralModuleService', 'error'], `Error creating device: ${ex.message}`);
        }
    }

    @bind
    private async deleteDeviceDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.DeleteDevice} command received`);

        try {
            const deviceId = commandRequest?.payload?.[DeleteDeviceRequestParams.DeviceId];
            if (!deviceId) {
                await commandResponse.send(202);
                await this.updateModuleProperties({
                    [IotcDiscoveryGatewayInterface.Command.DeleteDevice]: {
                        value: {
                            [CommandResponseParams.StatusCode]: 202,
                            [CommandResponseParams.Message]: `The ${IotcDiscoveryGatewayInterface.Command.DeleteDevice} command requires a Device Id parameter`,
                            [CommandResponseParams.Data]: ''
                        }
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
            this.server.log(['IoTCentralModuleService', 'error'], `Error deleting device: ${ex.message}`);
        }
    }

    @bind
    private async scanForDevicesDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.ScanForDevices} command received`);

        try {
            const result = await this.scanForDevices(commandRequest?.payload?.[ScanForDevicesRequestParams.ScanTime] || 5);

            await commandResponse.send(202);
            await this.updateModuleProperties({
                [IotcDiscoveryGatewayInterface.Command.ScanForDevices]: {
                    value: {
                        [CommandResponseParams.StatusCode]: 202,
                        [CommandResponseParams.Message]: result
                            ? `The ${IotcDiscoveryGatewayInterface.Command.ScanForDevices} command succeeded`
                            : `An error occurred while executing the ${IotcDiscoveryGatewayInterface.Command.ScanForDevices} command`,
                        [CommandResponseParams.Data]: ''
                    }

                }
            });
        }
        catch (ex) {
            this.server.log(['IoTCentralModuleService', 'error'], `Error while scanning for devices: ${ex.message}`);
        }
    }

    @bind
    private async restartModuleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['IoTCentralModuleService', 'info'], `${IotcDiscoveryGatewayInterface.Command.RestartModule} command received`);

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
            this.server.log(['IoTCentralModuleService', 'error'], `Error sending response for ${IotcDiscoveryGatewayInterface.Command.RestartModule} command: ${ex.message}`);
        }
    }

    private async iotcApiRequest(uri, method, options): Promise<any> {
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
            this.server.log(['ModuleService', 'error'], `iotcApiRequest: ${ex.message}`);
            throw ex;
        }
    }
}
