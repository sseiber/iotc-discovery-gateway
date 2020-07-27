import { Server } from '@hapi/hapi';
import { ConfigService } from './config';
import {
    defaultDetectionClass,
    defaultConfidenceThreshold,
    defaultInferenceInterval,
    defaultInferenceTimeout,
    InferenceProcessorService
} from './inferenceProcessor';
import { HealthState } from './health';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    Client as IoTDeviceClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import { bind, defer, emptyObj } from '../utils';

export interface IClientConnectResult {
    clientConnectionStatus: boolean;
    clientConnectionMessage: string;
}

interface IDeviceProperties {
    manufacturer: string;
    model: string;
    swVersion: string;
    osName: string;
    processorArchitecture: string;
    processorManufacturer: string;
    totalStorage: number;
    totalMemory: number;
}

enum IotcObjectDetectorSettings {
    DetectionClasses = 'wpDetectionClasses',
    ConfidenceThreshold = 'wpConfidenceThreshold',
    InferenceInterval = 'wpInferenceInterval',
    InferenceTimeout = 'wpInferenceTimeout',
    DebugTelemetry = 'wpDebugTelemetry'
}

interface IIotcObjectDetectorSettings {
    [IotcObjectDetectorSettings.DetectionClasses]: string;
    [IotcObjectDetectorSettings.ConfidenceThreshold]: number;
    [IotcObjectDetectorSettings.InferenceInterval]: number;
    [IotcObjectDetectorSettings.InferenceTimeout]: number;
    [IotcObjectDetectorSettings.DebugTelemetry]: boolean;
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum DeviceState {
    Inactive = 'inactive',
    Active = 'active'
}

enum CommandResponseParams {
    StatusCode = 'CommandResponseParams_StatusCode',
    Message = 'CommandResponseParams_Message',
    Data = 'CommandResponseParams_Data'
}

export const IotcObjectDetectorInterface = {
    Telemetry: {
        SystemHeartbeat: 'tlSystemHeartbeat',
        FreeMemory: 'tlFreeMemory',
        InferenceCount: 'tlInferenceCount',
        Inference: 'tlInference'
    },
    State: {
        IoTCentralClientState: 'stIoTCentralClientState',
        DeviceState: 'stDeviceState'
    },
    Event: {
        UploadImage: 'evUploadImage',
        DeviceStarted: 'evDeviceStarted',
        DeviceStopped: 'evDeviceStopped',
        VideoStreamProcessingStarted: 'evVideoStreamProcessingStarted',
        VideoStreamProcessingStopped: 'evVideoStreamProcessingStopped',
        VideoStreamProcessingError: 'evVideoStreamProcessingError'
    },
    Property: {
        InferenceImageUrl: 'rpInferenceImageUrl',
        DeviceName: 'rpDeviceName',
        RtspUrl: 'rpRtspUrl'
    },
    Setting: {
        DetectionClasses: IotcObjectDetectorSettings.DetectionClasses,
        ConfidenceThreshold: IotcObjectDetectorSettings.ConfidenceThreshold,
        InferenceInterval: IotcObjectDetectorSettings.InferenceInterval,
        InferenceTimeout: IotcObjectDetectorSettings.InferenceTimeout,
        DebugTelemetry: IotcObjectDetectorSettings.DebugTelemetry
    },
    Command: {
        StartImageProcessing: 'cmStartImageProcessing',
        StopImageProcessing: 'cmStopImageProcessing'
    }
};

export interface IDeviceTelemetry {
    debugTelemetry(): boolean;
    sendMeasurement(data: any): Promise<void>;
    sendInferenceData(inferenceTelemetryData: any): Promise<void>;
    updateDeviceProperties(properties: any): Promise<void>;
    uploadContent(data: Buffer): Promise<string>;
}

export class ObjectDetectorDevice implements IDeviceTelemetry {
    private server: Server;
    private config: ConfigService;
    private deviceId: string;
    private deviceName: string;
    private rtspUrl: string;

    private deviceClient: IoTDeviceClient = null;
    private deviceTwin: Twin = null;
    private deferredStart = defer();
    private healthState = HealthState.Good;
    private deviceSettings: IIotcObjectDetectorSettings = {
        [IotcObjectDetectorSettings.DetectionClasses]: defaultDetectionClass,
        [IotcObjectDetectorSettings.ConfidenceThreshold]: defaultConfidenceThreshold,
        [IotcObjectDetectorSettings.InferenceInterval]: defaultInferenceInterval,
        [IotcObjectDetectorSettings.InferenceTimeout]: defaultInferenceTimeout,
        [IotcObjectDetectorSettings.DebugTelemetry]: false
    };
    private detectionClasses: string[] = this.deviceSettings[IotcObjectDetectorSettings.DetectionClasses].toUpperCase().split(',');
    private inferenceProcessor: InferenceProcessorService;

    constructor(server: Server, config: ConfigService, deviceId: string, deviceName: string, rtspUrl: string) {
        this.server = server;
        this.config = config;
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.rtspUrl = rtspUrl;
    }

    public async init(): Promise<void> {
        this.server.log(['ObjectDetectorDevice', 'info'], 'initialize');
    }

    public debugTelemetry() {
        return this.deviceSettings[IotcObjectDetectorSettings.DebugTelemetry];
    }

    @bind
    public async getHealth(): Promise<number> {
        if (this.healthState === HealthState.Good && this.inferenceProcessor) {
            this.healthState = await this.inferenceProcessor.getHealth();
        }

        await this.sendMeasurement({
            [IotcObjectDetectorInterface.Telemetry.SystemHeartbeat]: this.healthState
        });

        return this.healthState;
    }

    public async deleteDevice(): Promise<void> {
        this.server.log(['ObjectDetectorDevice', 'info'], `Deleting device instance for deviceId: ${this.deviceId}`);

        try {
            const clientInterface = this.deviceClient;
            this.deviceClient = null;
            await clientInterface.close();

            await this.sendMeasurement({
                [IotcObjectDetectorInterface.State.DeviceState]: DeviceState.Inactive
            });
        }
        catch (ex) {
            this.server.log(['ObjectDetectorDevice', 'error'], `Error while deleting device: ${this.deviceId}`);
        }
    }

    public async connectDeviceClient(dpsHubConnectionString: string): Promise<IClientConnectResult> {
        let result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        try {
            result = await this.connectDeviceClientInternal(dpsHubConnectionString);

            if (result.clientConnectionStatus === true) {
                await this.deferredStart.promise;

                await this.deviceReady();
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `An error occurred while accessing the device twin properties`;

            this.server.log(['ObjectDetectorDevice', 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    @bind
    public async sendMeasurement(data: any): Promise<void> {
        if (!data || !this.deviceClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            await this.deviceClient.sendEvent(iotcMessage);

            if (this.debugTelemetry() === true) {
                this.server.log(['ObjectDetectorDevice', 'info'], `sendEvent: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['ObjectDetectorDevice', 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    public async sendInferenceData(inferenceTelemetryData: any) {
        if (!inferenceTelemetryData || !this.deviceClient) {
            return;
        }

        try {
            await this.sendMeasurement(inferenceTelemetryData);
        }
        catch (ex) {
            this.server.log(['ObjectDetectorDevice', 'error'], `sendInferenceData: ${ex.message}`);
        }
    }

    public async updateDeviceProperties(properties: any): Promise<void> {
        if (!properties || !this.deviceTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.deviceTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve();
                });
            });

            if (this.debugTelemetry() === true) {
                this.server.log(['ObjectDetectorDevice', 'info'], `Device properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log(['ObjectDetectorDevice', 'error'], `Error updating device properties: ${ex.message}`);
        }
    }

    public async uploadContent(data: Buffer): Promise<string> {
        if (!data) {
            return '';
        }

        this.server.log(['ObjectDetectorDevice', 'info'], `uploadContent - data length: ${data.length}`);

        return 'http://test/url';
    }

    private async getDeviceProperties(): Promise<IDeviceProperties> {
        return {
            manufacturer: 'AAA',
            model: '1000',
            swVersion: 'v1.0.0',
            osName: 'AAA OS',
            processorArchitecture: 'AAA CPU',
            processorManufacturer: 'AAA',
            totalStorage: 0,
            totalMemory: 0
        };
    }

    private async connectDeviceClientInternal(dpsHubConnectionString: string): Promise<IClientConnectResult> {
        const result: IClientConnectResult = {
            clientConnectionStatus: false,
            clientConnectionMessage: ''
        };

        if (this.deviceClient) {
            await this.deviceClient.close();
            this.deviceClient = null;
            this.deviceTwin = null;
        }

        try {
            this.deviceClient = await IoTDeviceClient.fromConnectionString(dpsHubConnectionString, Mqtt);
            if (!this.deviceClient) {
                result.clientConnectionStatus = false;
                result.clientConnectionMessage = `Failed to connect device client interface from connection string - device: ${this.deviceId}`;
            }
            else {
                result.clientConnectionStatus = true;
                result.clientConnectionMessage = `Successfully connected to IoT Central - device: ${this.deviceId}`;
            }
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `Failed to instantiate client interface from configuraiton: ${ex.message}`;

            this.server.log(['ObjectDetectorDevice', 'error'], `${result.clientConnectionMessage}`);
        }

        if (result.clientConnectionStatus === false) {
            return result;
        }

        try {
            await this.deviceClient.open();

            this.server.log(['ObjectDetectorDevice', 'info'], `Client is connected`);

            this.deviceTwin = await this.deviceClient.getTwin();
            this.deviceTwin.on('properties.desired', this.onHandleDeviceProperties);

            this.deviceClient.on('error', this.onDeviceClientError);

            this.deviceClient.onDeviceMethod(IotcObjectDetectorInterface.Command.StartImageProcessing, this.startImageProcessingDirectMethod);
            this.deviceClient.onDeviceMethod(IotcObjectDetectorInterface.Command.StopImageProcessing, this.stopImageProcessingDirectMethod);

            this.server.log(['ObjectDetectorDevice', 'info'], `IoT Central successfully connected device: ${this.deviceId}`);

            result.clientConnectionStatus = true;
        }
        catch (ex) {
            result.clientConnectionStatus = false;
            result.clientConnectionMessage = `IoT Central connection error: ${ex.message}`;

            this.server.log(['ObjectDetectorDevice', 'error'], result.clientConnectionMessage);
        }

        return result;
    }

    private async deviceReady(): Promise<void> {
        this.server.log(['ObjectDetectorDevice', 'info'], `Device ready`);

        const deviceProperties = await this.getDeviceProperties();

        await this.updateDeviceProperties({
            ...deviceProperties,
            [IotcObjectDetectorInterface.Property.DeviceName]: this.deviceName,
            [IotcObjectDetectorInterface.Property.RtspUrl]: this.rtspUrl
        });

        await this.sendMeasurement({
            [IotcObjectDetectorInterface.State.IoTCentralClientState]: IoTCentralClientState.Connected,
            [IotcObjectDetectorInterface.State.DeviceState]: DeviceState.Active,
            [IotcObjectDetectorInterface.Event.DeviceStarted]: 'Device initialization'
        });
    }

    @bind
    private onDeviceClientError(error: Error) {
        this.server.log(['ObjectDetectorDevice', 'error'], `Device client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    private async onHandleDeviceProperties(desiredChangedSettings: any) {
        try {
            this.server.log(['ObjectDetectorDevice', 'info'], `onHandleDeviceProperties`);
            if (this.debugTelemetry() === true) {
                this.server.log(['ObjectDetectorDevice', 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
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
                    case IotcObjectDetectorInterface.Setting.DetectionClasses: {
                        const detectionClassesString = (value || '');

                        this.detectionClasses = detectionClassesString.toUpperCase().split(',');

                        patchedProperties[setting] = detectionClassesString;
                        break;
                    }

                    case IotcObjectDetectorInterface.Setting.ConfidenceThreshold:
                        patchedProperties[setting] = (this.deviceSettings[setting] as any) = value || defaultConfidenceThreshold;
                        break;

                    case IotcObjectDetectorInterface.Setting.InferenceInterval:
                        patchedProperties[setting] = (this.deviceSettings[setting] as any) = value || defaultInferenceInterval;
                        break;

                    case IotcObjectDetectorInterface.Setting.InferenceTimeout:
                        patchedProperties[setting] = (this.deviceSettings[setting] as any) = value || defaultInferenceTimeout;
                        break;

                    case IotcObjectDetectorInterface.Setting.DebugTelemetry:
                        patchedProperties[setting] = (this.deviceSettings[setting] as any) = value || false;
                        break;

                    default:
                        this.server.log(['ObjectDetectorDevice', 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (!emptyObj(patchedProperties)) {
                await this.updateDeviceProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log(['ObjectDetectorDevice', 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    @bind
    // @ts-ignore (commandRequest)
    private async startImageProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ObjectDetectorDevice', 'info'], `Received device command: ${IotcObjectDetectorInterface.Command.StartImageProcessing}`);

        if (this.inferenceProcessor) {
            await this.inferenceProcessor.stopInferenceProcessor();

            this.inferenceProcessor = null;
        }

        this.inferenceProcessor = new InferenceProcessorService(
            this.server,
            this.config,
            this,
            this.deviceSettings[IotcObjectDetectorSettings.InferenceInterval],
            this.detectionClasses,
            this.deviceSettings[IotcObjectDetectorSettings.ConfidenceThreshold],
            this.deviceSettings[IotcObjectDetectorSettings.InferenceTimeout]);

        await this.inferenceProcessor.startInferenceProcessor(this.rtspUrl);

        await commandResponse.send(200);
        await this.updateDeviceProperties({
            [IotcObjectDetectorInterface.Command.StartImageProcessing]: {
                value: {
                    [CommandResponseParams.StatusCode]: 202,
                    [CommandResponseParams.Message]: `Received ${IotcObjectDetectorInterface.Command.StartImageProcessing} command for deviceId: ${this.deviceId}`,
                    [CommandResponseParams.Data]: ''
                }
            }
        });
    }

    @bind
    // @ts-ignore (commandRequest)
    private async stopImageProcessingDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log(['ObjectDetectorDevice', 'info'], `Received device command: ${IotcObjectDetectorInterface.Command.StopImageProcessing}`);

        if (this.inferenceProcessor) {
            await this.inferenceProcessor.stopInferenceProcessor();

            this.inferenceProcessor = null;
        }

        await commandResponse.send(200);
        await this.updateDeviceProperties({
            [IotcObjectDetectorInterface.Command.StopImageProcessing]: {
                value: {
                    [CommandResponseParams.StatusCode]: 202,
                    [CommandResponseParams.Message]: `Received ${IotcObjectDetectorInterface.Command.StopImageProcessing} command for deviceId: ${this.deviceId}`,
                    [CommandResponseParams.Data]: ''
                }
            }
        });
    }
}
