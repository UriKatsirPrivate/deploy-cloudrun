/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { run_v1 } from 'googleapis';
import { get, merge } from 'lodash';
import fs from 'fs';
import YAML from 'yaml';

/**
 * Available options to create the Service.
 *
 * @param image Name of the container image to deploy.
 * @param name Name of the Cloud Run service.
 * @param envVars String list of envvars.
 * @param yaml Path to YAML file.
 */
export type ServiceOptions = {
  image?: string;
  name?: string;
  envVars?: string;
  yaml?: string;
};

/**
 * Parses a string of the format `KEY1=VALUE1`.
 *
 * @param envVarInput Env var string to parse.
 * @returns EnvVar[].
 */
export function parseEnvVars(envVarInput: string): run_v1.Schema$EnvVar[] {
  const envVarList = envVarInput.split(',');
  const envVars = envVarList.map((envVar) => {
    if (!envVar.includes('=')) {
      throw new TypeError(
        `Env Vars must be in "KEY1=VALUE1,KEY2=VALUE2" format, received ${envVar}`,
      );
    }
    const keyValue = envVar.split('=');
    return { name: keyValue[0], value: keyValue[1] };
  });
  return envVars;
}

/**
 * Construct a Cloud Run Service.
 *
 * @param opts ServiceOptions.
 * @returns Service.
 */
export class Service {
  request: run_v1.Schema$Service;
  readonly name: string;

  constructor(opts: ServiceOptions) {
    if ((!opts.name || !opts.image) && !opts.yaml) {
      throw new Error('Provide image and services names or a YAML file.');
    }

    let request: run_v1.Schema$Service = {
      apiVersion: 'serving.knative.dev/v1',
      kind: 'Service',
      metadata: {},
      spec: {},
    };

    // Parse Env Vars
    let envVars;
    if (opts?.envVars) {
      envVars = parseEnvVars(opts.envVars);
    }

    // Parse YAML
    if (opts.yaml) {
      const file = fs.readFileSync(opts.yaml, 'utf8');
      const yaml = YAML.parse(file);
      request = yaml as run_v1.Schema$Service;
    }

    // If name is provided, set or override
    if (opts.name) {
      if (request.metadata) {
        request.metadata.name = opts.name;
      } else {
        request.metadata = { name: opts.name };
      }
    }

    // If image is provided, set or override YAML
    if (opts.image) {
      const container: run_v1.Schema$Container = { image: opts.image };
      if (get(request, 'spec.template.spec')) {
        request.spec!.template!.spec!.containers = [container];
      } else {
        request.spec = {
          template: {
            spec: {
              containers: [container],
            },
          },
        };
      }
    }

    if (!get(request, 'spec.template.spec.containers'))
      throw new Error(
        'No container defined. Set image as an input or in YAML config.',
      );

    // If Env Vars are provided, set or override YAML
    if (envVars) {
      if (get(request, 'spec.template.spec.containers[0]')) {
        request.spec!.template!.spec!.containers![0].env = envVars;
      }
    }

    this.request = request;
    this.name = request.metadata!.name!;
  }

  /**
   * Merges old revision with new service.
   *
   * @param prevService the previous Cloud Run service revision
   */
  public merge(prevService: run_v1.Schema$Service): void {
    // Get Revision names if set
    const name = get(this.request, 'spec.template.metadata.name');
    const previousName = get(prevService, 'spec.template.metadata.name');

    // Deep Merge Service
    const mergedServices = merge(prevService, this.request);

    // Force update with Revision name change
    mergedServices.spec!.template!.metadata!.name = this.generateRevisionName(
      name,
      previousName,
    );

    // Merge Container spec
    const prevEnvVars = prevService.spec!.template!.spec!.containers![0].env;
    const currentEnvVars = this.request.spec!.template!.spec!.containers![0]
      .env;

    // Merge Env vars
    let env: run_v1.Schema$EnvVar[] = [];
    if (currentEnvVars) {
      env = currentEnvVars.map((envVar) => envVar as run_v1.Schema$EnvVar);
    }
    const keys = env?.map((envVar) => envVar.name);
    prevEnvVars?.forEach((envVar) => {
      if (!keys.includes(envVar.name)) {
        // Add old env vars without duplicating
        return env.push(envVar);
      }
    });
    // Set Env vars
    mergedServices.spec!.template!.spec!.containers![0].env = env;
    this.request = mergedServices;
  }

  private generateRevisionName(name?: string, prevName?: string): string {
    const message =
      'Resource name must use only lowercase letters, numbers and ' +
      '. Must begin with a letter and cannot end with a ' +
      '. Maximum length is 63 characters.';
    if (name && name.length > 63) throw new Error(message);

    if (!name) {
      // Increment suffix number if set
      let num;
      if (prevName) {
        const suffix = prevName!.split('-');
        num = (parseInt(suffix[suffix.length - 2]) + 1).toString();
      } else {
        num = '1';
      }
      // Generate 3 random letters
      const letters = Math.random()
        .toString(36)
        .replace(/[^a-z]+/g, '')
        .substring(0, 3);
      // Set revision suffix "-XXXXX-abc"
      const newSuffix = `-${num.padStart(4, '0')}-${letters}`;
      const serviceName = this.name.substring(0, 53);
      name = serviceName + newSuffix;
    }
    return name;
  }
}
