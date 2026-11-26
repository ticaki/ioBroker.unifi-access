import { expect } from 'chai';

import { detectModel, featuresFor, type DeviceCapability, type UnifiDeviceModel } from './deviceModels';

describe('deviceModels', () => {
	describe('detectModel()', () => {
		const cases: [type: string | undefined, expected: UnifiDeviceModel][] = [
			// type strings from the documented device list (api_reference 8.1)
			['UAH', 'UA-Hub'],
			['UA-G2-PRO', 'UA-G2-Pro'],
			['UDA-LITE', 'UA-Lite'],
			['UA-LITE', 'UA-Lite'],
			// further type strings
			['UA-ULTRA', 'UA-Ultra'],
			['UA Ultra', 'UA-Ultra'],
			['UA-G3-PRO', 'UA-G3-Pro'],
			['UA-G3', 'UA-G3-Pro'],
			['UA-Hub', 'UA-Hub'],
			['UA-HUB-DOOR', 'UA-Hub'],
			// api_reference 11.7 (webhook device block of a UA Hub Gate) and the changelog (#7.10, #11.2)
			['UGT', 'UA-Hub'],
			['UA-Hub-Gate', 'UA-Hub'],
			['UA-Hub-Door-Mini', 'UA-Hub'],
			['EAH8', 'UA-Hub'],
			// api_reference 8.4: "trigger the doorbell on an Intercom or Reader Pro"
			['UA-Intercom', 'UA-Intercom'],
			['UA Intercom Viewer', 'UA-Intercom'],
			['something-else', 'unknown'],
			['', 'unknown'],
			[undefined, 'unknown'],
		];
		for (const [type, expected] of cases) {
			it(`maps type ${JSON.stringify(type)} to ${expected}`, () => {
				expect(detectModel(type, type)).to.equal(expected);
			});
		}

		it('is case-insensitive', () => {
			expect(detectModel('ua-ultra', undefined)).to.equal('UA-Ultra');
			expect(detectModel('uah', undefined)).to.equal('UA-Hub');
		});

		it('evaluates the raw model and the device type', () => {
			expect(detectModel(undefined, 'UA-G3-PRO')).to.equal('UA-G3-Pro');
			expect(detectModel('UA-G3-PRO', undefined)).to.equal('UA-G3-Pro');
			expect(detectModel('something', 'UAH')).to.equal('UA-Hub');
		});

		it('prefers the more specific reader model over the hub marker', () => {
			expect(detectModel('UA-ULTRA', 'UAH')).to.equal('UA-Ultra');
			expect(detectModel('UA-G2-PRO', 'connected to UAH')).to.equal('UA-G2-Pro');
		});
	});

	describe('featuresFor() capability matrix', () => {
		const matrix: Record<UnifiDeviceModel, DeviceCapability[]> = {
			'UA-Ultra': ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
			'UA-G3-Pro': ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
			// the documented WebSocket sample (11.1) shows a ringing UA-G2-PRO
			'UA-G2-Pro': ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
			'UA-Intercom': ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
			'UA-Lite': ['door-unlock', 'live-events'],
			'UA-Hub': ['live-events'],
			unknown: ['live-events'],
		};
		for (const [model, capabilities] of Object.entries(matrix) as [UnifiDeviceModel, DeviceCapability[]][]) {
			it(`${model}: ${capabilities.join(', ')}`, () => {
				expect([...featuresFor(model)].sort()).to.deep.equal([...capabilities].sort());
			});
		}

		it('falls back to the "unknown" capabilities for an unexpected model value', () => {
			expect([...featuresFor('not-a-model' as UnifiDeviceModel)]).to.deep.equal(['live-events']);
		});

		it('every model receives live events', () => {
			for (const model of Object.keys(matrix) as UnifiDeviceModel[]) {
				expect(featuresFor(model), model).to.include('live-events');
			}
		});
	});
});
