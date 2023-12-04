const core = require('@actions/core');
const github = require("@actions/github");
const {Base64} = require("js-base64");
const fs = require("fs");
const util = require('util');
const os = require("os");
const exec = util.promisify(require('child_process').exec);
const setup = require('./setup');
const AI = require('./AI');

async function estimateEnergy() {
    let modelData;
    try {
        const modelsContent = fs.readFileSync('models.json', 'utf8');
        const models = JSON.parse(modelsContent);
        console.log(`Models: ${models}`);
        const modelName = os.cpus()[0].model;
        const matchingModel = Object.keys(models).find(model => modelName.includes(model));

        if (matchingModel === undefined || matchingModel === null || matchingModel === '') {
            console.error(`No matching model found for ${modelName}`);
            return Promise.reject();
        }
        modelData = models[matchingModel];

    } catch (error) {
        console.error(`Error reading models.json: ${error}`);
        return Promise.reject();
    }
    AI.run();
    return Promise.resolve();
}

async function measureCpuUsage() {

    exec('killall -9 -q demo-reporter || true\n' +
        '/tmp/demo-reporter > /tmp/cpu-util.txt &');

    const unitTest = core.getInput('run');
    console.log("Running unit test: " + unitTest);
    await exec(unitTest);
    await exec('killall -9 -q demo-reporter');
    await estimateEnergy()

    const energyData = fs.readFileSync('/tmp/energy.txt', 'utf8');
    console.log("The data from the file is: " + energyData);

    return Promise.resolve();
}

function retrieveOctokit() {
    const github_token = core.getInput('GITHUB_TOKEN');
    if (!github_token) {
        console.error('Error: No GitHub secrets access');
        return core.setFailed('No GitHub secrets access');
    }
    return github.getOctokit(github_token);
}

function readEnergyData() {
    try {
        const energy = fs.readFileSync("/tmp/energy.txt", {encoding: 'utf8', flag: 'r'});
        const energy_numbers = energy.split('\n');

        let energy_sum = 0;
        for (let i = 0; i < energy_numbers.length; i++) {
            energy_sum += Number(energy_numbers[i]);
        }
        const power_avg = energy_sum / energy_numbers.length;

        return {
            "total_energy": energy_sum,
            "power_avg": power_avg,
            "duration": energy_numbers.length
        };
    } catch (error) {
        console.error(`Could not read data: ${error}`);
        return null;
    }
}

async function createBranch(octokit) {
    const owner = process.env.GITHUB_REPOSITORY.split('/')[0];
    const repo = process.env.GITHUB_REPOSITORY.split('/')[1];
    const branch = 'energy';

    try {
        // Check if branch exists
        await octokit.rest.git.getRef({
            owner: owner,
            repo: repo,
            ref: `/heads/${branch}`,
        });
        return branch;
    } catch (error) {
        console.log(`Branch ${branch} does not exist. Creating new branch.`);
    }

    try {
        // Create branch
        await octokit.rest.git.createRef({
            owner: owner,
            repo: repo,
            ref: `refs/heads/${branch}`,
            sha: github.context.sha,
        });
    } catch (error) {
        console.error(`Error while creating branch: ${error}`);
    }
    return branch;
}

async function commitReport(octokit, content) {
    const owner = process.env.GITHUB_REPOSITORY.split('/')[0];
    const repo = process.env.GITHUB_REPOSITORY.split('/')[1];
    const path = `.energy/${github.context.payload.head_commit.id}.json`;
    const message = "Add power report";
    const branch = await createBranch(octokit);

    try {
        await octokit.rest.repos.createOrUpdateFileContents({
            owner: owner,
            repo: repo,
            path: path,
            message: message,
            content: Base64.encode(JSON.stringify(content)),
            branch: branch,
        });
    } catch (error) {
        console.error(`Error while creating report: ${error}`);
    }
}

async function getPullRequest(octokit, sha) {
    try {
        const result = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            commit_sha: sha
        });
        const pull_request = result.data.filter(({state}) => state === 'open');
        if (pull_request.length === 0) {
            return null;
        }
        return pull_request[0];
    } catch (error) {
        console.error(`No pull request associated with push`);
        return null;
    }
}

async function getForkPoint(pull_request, octokit) {
    try {
        const owner = process.env.GITHUB_REPOSITORY.split('/')[0];
        const repo = process.env.GITHUB_REPOSITORY.split('/')[1];
        const basehead = `${pull_request.base.ref}...${pull_request.head.ref}`

        const response = await octokit.request(`GET /repos/{owner}/{repo}/compare/{basehead}`, {
            owner: owner,
            repo: repo,
            basehead: basehead,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        if (response.data.base_commit.commit.message === 'Add power report') {
            return response.data.merge_base_commit.parents[0].sha;
        }
        return response.data.merge_base_commit.sha;
    } catch (error) {
        console.error(`Could not find fork point: ${error}`);
        return null;
    }
}

async function getMeasurementsFromRepo(octokit, sha) {
    try {
        const owner = process.env.GITHUB_REPOSITORY.split('/')[0];
        const repo = process.env.GITHUB_REPOSITORY.split('/')[1];
        const path = `.energy/${sha}.json`;
        const ref = `energy`;

        console.log(`Getting measurements from ${path} in ${ref}`);

        const result = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref,
        });
        const content = Buffer.from(result.data['content'], 'base64').toString()
        return JSON.parse(content);
    } catch (error) {
        console.error(`Could not find old measurements: ${error}`);
        return null;
    }
}

async function createComment(octokit, data, difference, pull_request) {
    const issueNumber = pull_request.number;
    let body = `⚡ The total energy is: ${data['total_energy']}\n💪 The power is: ${Math.round((data['power_avg'] + Number.EPSILON) * 100) / 100}\n🕒 The duration is: ${data['duration']}`;
    if (difference !== null) {
        if (difference >= -0.5 && difference <= 0.5) {
            body += '\n\nNo significant difference has been found compared to the base branch.';
        } else if (difference > 0.5) {
            body += `\n\n<code style="color : red">${Math.round((difference * 100) + Number.EPSILON)}%</code> lower than the base branch`;
        } else {
            body += `\n\n<code style="color : green">${Math.round((difference * 100) + Number.EPSILON)}%</code> higher than the base branch`;
        }
    }

    try {
        await octokit.rest.issues.createComment({
            ...github.context.repo,
            issue_number: issueNumber,
            body: body,
        });
    } catch (error) {
        console.error(`Could not create comment: ${error}`);
    }
}

async function compareToOld(octokit, new_data, old_data) {
    if (old_data === null) {
        return null;
    }
    console.log(`Old data: ${old_data['total_energy']}`);
    console.log(`New data: ${new_data['total_energy']}`);
    return Math.round(((old_data['total_energy'] / new_data['total_energy']) + Number.EPSILON) * 100) / 100
}

async function run() {
    try {
        setup.run();
        await measureCpuUsage();

        const octokit = retrieveOctokit();
        const energy_data = readEnergyData();
        await commitReport(octokit, energy_data);

        const pull_request = await getPullRequest(octokit, github.context.sha);
        if (pull_request === null) {
            return;
        }
        const sha = await getForkPoint(pull_request, octokit);
        if (sha === null) {
            return;
        }
        const old_data = await getMeasurementsFromRepo(octokit, sha);
        const difference = await compareToOld(octokit, energy_data, old_data);
        await createComment(octokit, energy_data, difference, pull_request);

        return Promise.resolve();
    } catch (error) {
        console.error(error);
        core.setFailed(error.message);
        return Promise.reject();
    }
}

run();