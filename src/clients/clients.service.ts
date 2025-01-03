import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateClientDto } from './dto/CreateClientDto';
import { GeneralLedger, JournalEntry } from '@prisma/client';
import { GeneralLedgerService } from 'src/general-ledger/general-ledger.service';

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private generalLedger: GeneralLedgerService,
  ) {}

  async createClient(
    companyId: string,
    data: {
      name: string;
      email?: string;
      phone?: string;
      address?: string;
      openingBalance?: number;
    },
  ): Promise<any> {
    const accountsReceivable = await this.prisma.account.findFirst({
      where: { companyId, code: '1.1.3' }, // Accounts Receivable
      select: { id: true },
    });

    if (!accountsReceivable) {
      throw new NotFoundException('Accounts Receivable account not found');
    }

    const openingBalance = data.openingBalance || 0.0;

    // Create client and directly associate with account
    const clientDetails = await this.prisma.customer.create({
      data: {
        companyId,
        name: data.name,
        email: data.email || null,
        phone: data.phone || null,
        address: data.address || null,
        openingBalance,
        currentBalance: openingBalance,
      },
    });

    // Create account linked to this client
    await this.prisma.account.create({
      data: {
        companyId,
        name: `${data.name} - Receivable`,
        accountType: 'ASSET',
        currentBalance: openingBalance,
        code: `1.1.3.${clientDetails.id}`, // Unique code per client
        parentAccountId: accountsReceivable.id, // Link to the main AR account
      },
    });

    return clientDetails;
  }

  async getClients(companyId: string) {
    console.log('Fetching clients for company');
    return this.prisma.customer.findMany({
      where: {
        companyId,
      },
      select: {
        id: true,
        name: true,
        currentBalance: true,
        openingBalance: true,
        phone: true,
        email: true,
        address: true,
      },
    });
  }

  async ensureCustomerExists(
    clientId: string,
    clientName: string,
    companyId: string,
  ) {
    console.log('Checking if customer exists', clientId);
    const existingCustomer = await this.prisma.customer.findUnique({
      where: { id: clientId },
    });

    if (existingCustomer) {
      console.log('Customer exists:', existingCustomer);
      return existingCustomer;
    }

    console.log('Customer does not exist, creating a new one');
    return this.prisma.customer.create({
      data: {
        name: clientName,
        companyId,
        openingBalance: 0.0,
        currentBalance: 0.0,
      },
    });
  }

  async bulkCreateClients(
    createClientDtos: CreateClientDto[],
    companyId: string,
  ) {
    const results: any[] = [];

    // Retrieve critical accounts outside the loop
    const [accountsReceivable, openingBalanceEquity] = await Promise.all([
      this.prisma.account.findFirst({
        where: { companyId, code: '1.1.3' },
      }),
      this.prisma.account.findFirst({
        where: { companyId, code: '3.2' },
      }),
    ]);

    if (!accountsReceivable || !openingBalanceEquity) {
      throw new Error(
        `Critical accounts missing: ${!accountsReceivable ? 'Accounts Receivable' : ''} ${
          !openingBalanceEquity ? 'Opening Balance Equity' : ''
        }. Ensure the accounts exist in the chart of accounts.`,
      );
    }

    await this.prisma.$transaction(async (prisma) => {
      for (const clientDto of createClientDtos) {
        // Validate duplicate clients if taxId exists
        if (clientDto.taxId) {
          const existingClient = await prisma.customer.findFirst({
            where: {
              taxId: clientDto.taxId,
              companyId,
            },
          });

          if (existingClient) {
            throw new Error(
              `Client with taxId ${clientDto.taxId} already exists for companyId ${companyId}.`,
            );
          }
        }

        // Create the client
        const client = await prisma.customer.create({
          data: {
            name: clientDto.name,
            nameAr: clientDto.nameAr || null,
            email: clientDto.email || null,
            phone: clientDto.phone || null,
            address: clientDto.address || null,
            taxId: clientDto.taxId || null,
            openingBalance: clientDto.openingBalance || 0.0,
            currentBalance: clientDto.openingBalance || 0.0,
            companyId,
          },
        });

        // Handle opening balance
        if (clientDto.openingBalance && clientDto.openingBalance !== 0) {
          const isDebit = clientDto.openingBalance > 0;
          const absoluteBalance = Math.abs(clientDto.openingBalance);

          // Create a balanced journal entry
          const journalEntry = await prisma.journalEntry.create({
            data: {
              number: '',
              companyId,
              date: new Date(),
              transactions: {
                create: [
                  {
                    accountId: accountsReceivable.id,
                    customerId: client.id,
                    debit: isDebit ? absoluteBalance : 0.0,
                    credit: isDebit ? 0.0 : absoluteBalance,
                    companyId,
                    notes: `Opening balance journal for client ${clientDto.name} (${clientDto.taxId || 'N/A'}).`,
                  },
                  {
                    accountId: openingBalanceEquity.id,
                    debit: isDebit ? 0.0 : absoluteBalance,
                    credit: isDebit ? absoluteBalance : 0.0,
                    companyId,
                    notes: `Offset for opening balance of client ${clientDto.name}.`,
                  },
                ],
              },
            },
          });

          console.log(
            `Journal entry created for client ${client.name}`,
            journalEntry,
          );
        }

        results.push(client);
      }
    });

    return {
      success: results,
      message: `${results.length} clients successfully created.`,
    };
  }

  async getClientAccountStatement(
    clientId: string,
    companyId: string,
  ): Promise<any[]> {
    const balance = await this.generalLedger.calculateRunningBalance(clientId);
    console.log(balance);

    const transactions = await this.prisma.generalLedger.findMany({
      where: { customerId: clientId, companyId },
      orderBy: { date: 'asc' },
      include: { account: true },
    });

    let runningBalance = 0;

    return transactions.map((transaction) => {
      runningBalance += (transaction.debit || 0) - (transaction.credit || 0);
      return {
        date: transaction.date,
        description: transaction.notes || 'No description',
        debit: transaction.debit,
        credit: transaction.credit,
        runningBalance,
      };
    });
  }

  async getClientDetails(clientId: string, companyId: string): Promise<any> {
    const balance = await this.generalLedger.calculateRunningBalance(clientId);
    console.log(balance);
    const client = await this.prisma.customer.findFirst({
      where: { id: clientId, companyId },
      include: {
        invoices: true, // Include all related invoices
        Transaction: true, // Include all related transactions
        GeneralLedger: true, // Include all related general ledger entries
      },
    });

    if (!client) {
      throw new NotFoundException(`Client with ID ${clientId} not found.`);
    }

    // Calculate the client's current balance
    const totalDebit = client.Transaction.reduce(
      (sum, transaction) => sum + transaction.debit,
      0,
    );
    const totalCredit = client.Transaction.reduce(
      (sum, transaction) => sum + transaction.credit,
      0,
    );
    const currentBalance = totalDebit - totalCredit;

    return {
      ...client,
      currentBalance, // Add calculated balance to the response
    };
  }
}
